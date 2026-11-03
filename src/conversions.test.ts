import { describe, expect, it } from "vitest";
import {
  allocateBatch,
  batchLegs,
  conversionRef,
  conversionRefLegs,
  formatUnits,
  toUnits,
  type PlannedConversion,
  type TraspasoLeg,
} from "./conversions";
import type { FondosRow } from "./types";

let nextNum = 1000;

function leg(
  dir: "out" | "in",
  isin: string,
  titulos: string,
  value: number | undefined,
  fechaOperacion = "2026-03-02",
  divisa = "EUR",
): TraspasoLeg {
  const numOp = String(nextNum++);
  const row: FondosRow = {
    fechaOperacion,
    fechaLiquidacion: fechaOperacion,
    numOperacion: numOp,
    mercado: "FONDOS EXTRANJEROS",
    operacion: dir === "out" ? "BAJA IIC SWITCH" : "ALTA IIC SWITCH",
    isin,
    nombre: `FUND ${isin}`,
    titulos,
    divisa,
    precio: "1",
    importe: value == null ? "" : value.toFixed(2),
  };
  return { row, dir, numOp, value };
}

function sumUnits(xs: string[]): bigint {
  return xs.reduce((s, x) => s + toUnits(x), 0n);
}

describe("fixed-point units", () => {
  it("round-trips decimal strings exactly", () => {
    expect(formatUnits(toUnits("5.00000000"))).toBe("5");
    expect(formatUnits(toUnits("123456.12345678"))).toBe("123456.12345678");
    expect(formatUnits(toUnits("0.0000000001"))).toBe("0.0000000001");
  });
});

describe("conversion refs", () => {
  it("are independent of leg order and parse back to their legs", () => {
    expect(conversionRef(["12", "3"], ["7", "100"])).toBe("c3+12>7+100");
    expect(conversionRefLegs("c3+12>7+100")).toEqual(["3", "12", "7", "100"]);
    expect(conversionRefLegs("000000000012")).toBeUndefined();
    expect(conversionRefLegs("z1a2b3c4d")).toBeUndefined();
  });
});

describe("batchLegs", () => {
  it("closes a batch once out-value and in-value balance", () => {
    const legs = [leg("out", "A", "10", 100), leg("in", "B", "5", 50, "2026-03-04"), leg("in", "B", "5", 50, "2026-03-05")];
    const { batches, released } = batchLegs(legs);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(released).toHaveLength(0);
  });

  it("tolerates cent-level rounding but not a real mismatch", () => {
    expect(batchLegs([leg("out", "A", "1", 100), leg("in", "B", "1", 100.04)]).batches).toHaveLength(1);
    expect(batchLegs([leg("out", "A", "1", 100), leg("in", "B", "1", 103)]).batches).toHaveLength(0);
  });

  it("releases a stray leg without poisoning the switches after it", () => {
    const stray = leg("in", "X", "1", 37, "2026-03-01"); // e.g. traspaso in from another bank
    const legs = [
      stray,
      leg("out", "A", "10", 100, "2026-03-02"),
      leg("in", "B", "5", 100, "2026-03-04"),
      leg("out", "B", "5", 110, "2026-04-02"),
      leg("in", "C", "2", 110, "2026-04-03"),
    ];
    const { batches, released } = batchLegs(legs);
    expect(released).toEqual([stray]);
    expect(batches.map((b) => b.map((l) => l.row.isin).join(""))).toEqual(["AB", "BC"]);
  });

  it("does not close across a leg with no value (no exchange rate)", () => {
    const { batches, released } = batchLegs([leg("out", "A", "1", 100), leg("in", "U", "1", undefined, "2026-03-02", "USD")]);
    expect(batches).toHaveLength(0);
    expect(released).toHaveLength(2);
  });

  it("gives up on a batch that doesn't balance within the window", () => {
    const { batches, released } = batchLegs([leg("out", "A", "1", 100, "2026-03-01"), leg("in", "B", "1", 100, "2026-03-20")]);
    expect(batches).toHaveLength(0);
    expect(released).toHaveLength(2);
  });
});

describe("allocateBatch", () => {
  it("splits 2 leaving funds into 11 same-day fragments of one fund as 2 conversions, using every unit exactly once", () => {
    const outs = [leg("out", "A", "7.12345678", 300), leg("out", "D", "3.33333333", 200)];
    const ins = Array.from({ length: 11 }, (_, i) => leg("in", "B", "1.11111111", i < 10 ? 45 : 50, "2026-03-04"));
    const planned = allocateBatch([...outs, ...ins]) as PlannedConversion[];
    expect(planned).toHaveLength(2);
    const byOut = new Map(planned.map((p) => [p.outRow.isin, p]));
    expect(byOut.get("A")!.outUnits).toBe("7.12345678");
    expect(byOut.get("D")!.outUnits).toBe("3.33333333");
    // In units split 60/40 by out-value; the pieces add up exactly.
    expect(sumUnits(planned.map((p) => p.inUnits))).toBe(toUnits("12.22222221"));
    expect(parseFloat(byOut.get("A")!.inUnits)).toBeCloseTo(12.22222221 * 0.6, 8);
    expect(byOut.get("A")!.ref).toBe(conversionRef([outs[0].numOp], ins.map((l) => l.numOp)));
    for (const p of planned) expect(p.day).toBe("2026-03-04");
  });

  it("makes one conversion per (leaving fund, arriving fund, arrival day), never sending out more units than left", () => {
    const outs = [leg("out", "A", "10", 100), leg("out", "A", "0.00000001", 0.01)];
    const ins = [leg("in", "B", "3", 33.34, "2026-03-03"), leg("in", "B", "3", 33.33, "2026-03-04"), leg("in", "C", "1", 33.34, "2026-03-04")];
    const planned = allocateBatch([...outs, ...ins]) as PlannedConversion[];
    expect(planned.map((p) => `${p.inRow.isin}@${p.day}`)).toEqual(["B@2026-03-03", "B@2026-03-04", "C@2026-03-04"]);
    expect(sumUnits(planned.map((p) => p.outUnits))).toBe(toUnits("10.00000001"));
    expect(new Set(planned.map((p) => p.ref)).size).toBe(3);
  });

  it("refuses a switch of a fund into itself", () => {
    expect(allocateBatch([leg("out", "A", "1", 10), leg("in", "A", "1", 10)])).toMatch(/into itself/);
  });

  it("is deterministic regardless of leg order", () => {
    const legs = [leg("out", "A", "10", 100), leg("out", "D", "4", 50), leg("in", "B", "7", 90), leg("in", "C", "3", 60)];
    const a = allocateBatch(legs) as PlannedConversion[];
    const b = allocateBatch([...legs].reverse()) as PlannedConversion[];
    expect(b.map((p) => [p.ref, p.outUnits, p.inUnits])).toEqual(a.map((p) => [p.ref, p.outUnits, p.inUnits]));
  });
});
