import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { describe, expect, it } from "vitest";
import { findExistingMatches } from "./dedup";
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
