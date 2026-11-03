import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { describe, expect, it } from "vitest";
import { findExistingMatches, planConversionBatches } from "./dedup";
import type { ExistingActivity } from "./dedup";

function imported(lineNumber: number, overrides: Partial<ActivityImport>): ActivityImport {
  return {
    accountId: "acc",
    activityType: "DEPOSIT",
    date: "2026-03-04T00:00:00.000Z",
    symbol: "$CASH-EUR",
    quantity: "1",
    unitPrice: "1",
    amount: "50",
    currency: "EUR",
    comment: "Monthly savings [ref:zab12cd34]",
    isValid: true,
    isDraft: false,
    lineNumber,
    ...overrides,
  } as ActivityImport;
}

function existing(id: string, overrides: Partial<ExistingActivity>): ExistingActivity {
  return {
    id,
    activityType: "DEPOSIT",
    date: "2026-03-04",
    quantity: 1,
    unitPrice: 1,
    amount: 50,
    fxRate: null,
    comment: "Monthly savings [ref:z0000000051]",
    ...overrides,
  };
}

describe("findExistingMatches", () => {
  it("recognises a cash activity imported earlier under a different ref tag", () => {
    // Older versions tagged movimientos rows with their file position, so
    // the same deposit came back with a new [ref:...].
    const matches = findExistingMatches([imported(1, {})], [existing("e1", {})]);
    expect(matches.get(1)).toEqual({ existingId: "e1", differs: false });
  });

  it("doesn't match a different amount, type, or day", () => {
    const acts = [
      imported(1, { amount: "100" }),
      imported(2, { activityType: "WITHDRAWAL" }),
      imported(3, { date: "2026-03-05T00:00:00.000Z" }),
    ];
    expect(findExistingMatches(acts, [existing("e1", {})]).size).toBe(0);
  });

  it("matches each existing activity at most once", () => {
    const matches = findExistingMatches([imported(1, {}), imported(2, { comment: "Monthly savings [ref:zab12cd34-2]" })], [existing("e1", {})]);
    expect(matches.size).toBe(1);
    expect(matches.get(1)?.existingId).toBe("e1");
  });

  it("matches fund trades by the broker's operation number and flags changed economics", () => {
    const trade = imported(1, {
      activityType: "SELL",
      symbol: "SAMPLEUSD",
      quantity: "10",
      unitPrice: "8",
      amount: undefined,
      currency: "USD",
      fxRate: "0.86",
      comment: "SAMPLE USD FUND - fund switch (traspaso) out [ref:000000000101]",
    });
    const old = existing("e9", {
      activityType: "SELL",
      date: "2026-03-04",
      quantity: 10,
      unitPrice: 8,
      amount: 80,
      fxRate: 0.85,
      comment: "SAMPLE USD FUND - fund switch (traspaso) out [ref:000000000101]",
    });
    expect(findExistingMatches([trade], [old]).get(1)).toEqual({ existingId: "e9", differs: true });
  });

  it("matches a fund trade by operation number even when its derived price changed", () => {
    const trade = imported(1, {
      activityType: "BUY",
      quantity: "5",
      unitPrice: "10",
      amount: undefined,
      comment: "SAMPLE WORLD INDEX P ACC EUR - SUSCRIPCION [ref:000000000102]",
    });
    const wrong = existing("bad", {
      activityType: "BUY",
      quantity: 5,
      unitPrice: 2.4,
      amount: 12,
      comment: "SAMPLE WORLD INDEX P ACC EUR - SUSCRIPCION [ref:000000000102]",
    });
    expect(findExistingMatches([trade], [wrong]).get(1)).toEqual({ existingId: "bad", differs: true });
  });
});

describe("fund switch conversions", () => {
  const conv = (lineNumber: number, subtype: string, quantity: string, ref = "c200>201") =>
    imported(lineNumber, {
      activityType: "ADJUSTMENT",
      subtype,
      symbol: subtype === "CONVERSION_OUT" ? "IE00AAAAAAA1" : "IE00BBBBBBB2",
      quantity,
      unitPrice: undefined,
      amount: undefined,
      sourceGroupId: `myinvestor:${ref}`,
      comment: `FUND A → FUND B - fund switch (traspaso) ${subtype === "CONVERSION_OUT" ? "out" : "in"} [ref:${ref}]`,
    });
  const existingConv = (id: string, subtype: string, quantity: number, ref = "c200>201") =>
    existing(id, {
      activityType: "ADJUSTMENT",
      subtype,
      quantity,
      unitPrice: null,
      amount: null,
      comment: `FUND A → FUND B - fund switch (traspaso) ${subtype === "CONVERSION_OUT" ? "out" : "in"} [ref:${ref}]`,
    });
  const oldTrade = (id: string, activityType: string, numOp: string) =>
    existing(id, { activityType, quantity: 10, unitPrice: 12, amount: null, comment: `FUND - fund switch (traspaso) [ref:${numOp.padStart(12, "0")}]` });
  const batch = { id: "c200>201", refs: ["c200>201"], legNumOps: ["200", "201"], lineNumbers: [1, 2] };
  const rows = [conv(1, "CONVERSION_OUT", "10"), conv(2, "CONVERSION_IN", "6")];

  it("replaces the BUY/SELL an earlier import booked for the batch's legs", () => {
    const unrelated = oldTrade("t3", "BUY", "999");
    const [plan] = planConversionBatches([batch], rows, [oldTrade("t1", "SELL", "200"), oldTrade("t2", "BUY", "201"), unrelated]);
    expect(plan.createLines).toEqual([1, 2]);
    expect(plan.deleteIds).toEqual(["t1", "t2"]);
    expect(plan.replacedTrades).toBe(2);
    expect(plan.existingLines.size).toBe(0);
  });

  it("recognises an exact re-import and touches nothing", () => {
    const [plan] = planConversionBatches([batch], rows, [existingConv("o", "CONVERSION_OUT", 10), existingConv("i", "CONVERSION_IN", 6)]);
    expect(plan.createLines).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect([...plan.existingLines]).toEqual([
      [1, "o"],
      [2, "i"],
    ]);
  });

  it("replaces both rows of a conversion an earlier allocation built from the same legs", () => {
    const [plan] = planConversionBatches(
      [batch],
      rows,
      [existingConv("o", "CONVERSION_OUT", 10, "c200>201+202"), existingConv("i", "CONVERSION_IN", 7, "c200>201+202")],
    );
    expect(plan.createLines).toEqual([1, 2]);
    expect(plan.deleteIds).toEqual(["i", "o"]);
    expect(plan.replacedTrades).toBe(0);
  });

  it("replaces a same-ref conversion whose units changed", () => {
    const [plan] = planConversionBatches([batch], rows, [existingConv("o", "CONVERSION_OUT", 10), existingConv("i", "CONVERSION_IN", 5)]);
    expect(plan.createLines).toEqual([1, 2]);
    expect(plan.deleteIds).toEqual(["i", "o"]);
  });

  it("findExistingMatches leaves conversion rows to the batch plan", () => {
    const matches = findExistingMatches(rows, [existingConv("o", "CONVERSION_OUT", 10), existingConv("i", "CONVERSION_IN", 6)]);
    expect(matches.size).toBe(0);
  });

  it("flags a fallback BUY/SELL leg that an earlier import already put into a conversion", () => {
    const sell = imported(5, {
      activityType: "SELL",
      symbol: "IE00AAAAAAA1",
      quantity: "10",
      unitPrice: "12",
      amount: undefined,
      comment: "FUND A - fund switch (traspaso) out [ref:000000000200]",
    });
    const matches = findExistingMatches([sell], [existingConv("o", "CONVERSION_OUT", 10), existingConv("i", "CONVERSION_IN", 6)]);
    expect(matches.get(5)).toEqual({ existingId: "o", differs: false, alreadyConverted: true });
  });
});
