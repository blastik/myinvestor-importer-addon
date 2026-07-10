import { describe, expect, it } from "vitest";
import { transform } from "./transform";
import type { AddonSettings, FondosRow, MovimientosRow } from "./types";

const CONFIG: AddonSettings = {
  accountId: "myinvestor",
  securityMappings: {},
};

function fondosRow(overrides: Partial<FondosRow>): FondosRow {
  return {
    fechaOperacion: "2026-01-06",
    fechaLiquidacion: "2026-01-09",
    numOperacion: "247469778",
    mercado: "FONDOS EXTRANJEROS",
    operacion: "SUSCRIPCION",
    isin: "IE000QAZP7L2",
    nombre: "ISHARES EMERGING MRK IND S EUR",
    titulos: "4.61000000",
    divisa: "EUR",
    precio: "11.6260000",
    importe: "53.71",
    ...overrides,
  };
}

function movRow(overrides: Partial<MovimientosRow>): MovimientosRow {
  return {
    fechaOperacion: "2026-01-06",
    fechaValor: "2026-01-09",
    tipo: "SUSCRIPCION IIC",
    concepto: "ISHARES EMERGING MRK IND S EUR @ 4.61",
    divisa: "EUR",
    importe: "-53,71",
    ...overrides,
  };
}

describe("SUSCRIPCION / REEMBOLSO (matched buy/sell)", () => {
  it("merges a EUR fund SUSCRIPCION into a single BUY, no fxRate, unitPrice derived from real cash", () => {
    const { activities, skipped } = transform([fondosRow({})], [movRow({})], CONFIG);
    expect(skipped).toHaveLength(0);
    expect(activities).toHaveLength(1);
    const [buy] = activities;
    expect(buy.activityType).toBe("BUY");
    expect(buy.symbol).toBe("IE000QAZP7L2");
    expect(buy.quantity).toBe("4.61000000");
    // Wealthfolio ignores fxRate when activity currency == account currency
    // (both EUR here), so unitPrice is derived from the real EUR cash
    // amount / quantity (53.71 / 4.61) rather than MyInvestor's stated
    // "Precio Neto" (11.6260000) — this makes quantity * unitPrice match
    // the actual cash debited exactly, eliminating NAV-rounding drift that
    // would otherwise accumulate into a real account balance mismatch.
    expect(parseFloat(String(buy.unitPrice))).toBeCloseTo(53.71 / 4.61, 6);
    expect(buy.currency).toBe("EUR");
    expect(buy.fxRate).toBeUndefined();
    expect(buy.accountId).toBe("myinvestor");
  });

  it("computes an explicit fxRate for a USD fund so EUR cash settlement is exact", () => {
    const fondos = fondosRow({
      operacion: "SUSCRIPCION",
      isin: "IE00BDZVHT63",
      nombre: "MSCI PACFC EXJAPN IDX P AC USD",
      titulos: "0.85500000",
      divisa: "USD",
      precio: "7.5002000",
      importe: "6.42",
      fechaLiquidacion: "2026-01-05",
    });
    const mov = movRow({
      fechaValor: "2026-01-05",
      concepto: "MSCI PACFC EXJAPN IDX P AC USD @ 0.855",
      importe: "-5,47",
    });
    const { activities } = transform([fondos], [mov], CONFIG);
    expect(activities).toHaveLength(1);
    const [buy] = activities;
    expect(buy.currency).toBe("USD");
    expect(buy.fxRate).toBeDefined();
    // 5.47 EUR / (0.855 * 7.5002 USD) ~= 0.852
    expect(parseFloat(String(buy.fxRate))).toBeCloseTo(5.47 / (0.855 * 7.5002), 3);
  });

  it("merges REEMBOLSO into a single SELL", () => {
    const fondos = fondosRow({ operacion: "REEMBOLSO", titulos: "13.44500000", precio: "8.1113000", importe: "109.05" });
    const mov = movRow({ tipo: "REEMBOLSO IIC", concepto: "ISHARES EMERGING MRK IND S EUR @ 13.445", importe: "+109,05" });
    const { activities } = transform([fondos], [mov], CONFIG);
    expect(activities).toHaveLength(1);
    expect(activities[0].activityType).toBe("SELL");
  });

  it("skips a SUSCRIPCION with no matching cash movement when movimientos was uploaded", () => {
    const fondos = fondosRow({});
    const unrelatedMov = movRow({ concepto: "SOME OTHER FUND @ 99.9" });
    const { activities, skipped } = transform([fondos], [unrelatedMov], CONFIG);
    expect(activities).toHaveLength(0);
    // Both sides are unmatched: the fondos row has no cash counterpart, and
    // the movimientos row has no fund detail — each is flagged independently.
    expect(skipped).toHaveLength(2);
    expect(skipped.find((s) => s.source === "fondos")?.reason).toMatch(/no matching cash movement/i);
    expect(skipped.find((s) => s.source === "movimientos")?.reason).toMatch(/no matching fund detail/i);
  });

  it("falls back to native-currency booking when only the fondos file is uploaded", () => {
    const { activities, skipped } = transform([fondosRow({})], [], CONFIG);
    expect(skipped).toHaveLength(0);
    expect(activities).toHaveLength(1);
    expect(activities[0].fxRate).toBeUndefined();
    // No real cash amount to derive from — MyInvestor's own stated price is
    // the best available.
    expect(activities[0].unitPrice).toBe("11.6260000");
  });

  it("EUR BUY cash impact (quantity * unitPrice) reconciles exactly to the real EUR debit despite NAV-rounding in the stated price", () => {
    const fondos = fondosRow({ titulos: "4.61000000", precio: "11.6260000" }); // 4.61 * 11.626 = 53.60986, not 53.71
    const mov = movRow({ importe: "-53,71" });
    const { activities } = transform([fondos], [mov], CONFIG);
    const [buy] = activities;
    const cashImpact = parseFloat(String(buy.quantity)) * parseFloat(String(buy.unitPrice));
    expect(cashImpact).toBeCloseTo(53.71, 6);
  });

  it("skips an unmatched SUSCRIPCION IIC cash row when only movimientos was uploaded", () => {
    const { activities, skipped } = transform([], [movRow({})], CONFIG);
    expect(activities).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/no matching fund detail/i);
  });
});

describe("fund switches (traspasos) — modeled as BUY/SELL, cash-neutral by construction", () => {
  // BUY/SELL never touch net_contribution and never sweep cash from a
  // separate account, so simply not funding these from movimientos already
  // makes them cash-neutral in practice — no special-casing needed, unlike
  // the earlier TRANSFER_IN/TRANSFER_OUT model.
  it("SUSCR.POR TRASPASO I becomes BUY with zero fee", () => {
    const fondos = fondosRow({ operacion: "SUSCR.POR TRASPASO I" });
    const { activities, skipped } = transform([fondos], [], CONFIG);
    expect(skipped).toHaveLength(0);
    expect(activities).toHaveLength(1);
    expect(activities[0].activityType).toBe("BUY");
    expect(activities[0].fee).toBe("0");
  });

  it("REEMB.POR TRASPASO I becomes SELL", () => {
    const fondos = fondosRow({ operacion: "REEMB.POR TRASPASO I" });
    const { activities } = transform([fondos], [], CONFIG);
    expect(activities[0].activityType).toBe("SELL");
  });

  it("ALTA/BAJA IIC SWITCH map to BUY/SELL independently (no shared group, no pairing needed)", () => {
    const alta = fondosRow({ operacion: "ALTA IIC SWITCH", numOperacion: "1" });
    const baja = fondosRow({ operacion: "BAJA IIC SWITCH", numOperacion: "2", isin: "IE00OTHER0001" });
    const { activities } = transform([alta, baja], [], CONFIG);
    expect(activities).toHaveLength(2);
    const buy = activities.find((a) => a.activityType === "BUY")!;
    const sell = activities.find((a) => a.activityType === "SELL")!;
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
  });

  it("does NOT try to match traspaso/switch rows against movimientos", () => {
    const fondos = fondosRow({ operacion: "SUSCR.POR TRASPASO I" });
    // Even with an unrelated movimientos row present, this must not be skipped.
    const { activities, skipped } = transform([fondos], [movRow({ concepto: "UNRELATED @ 1" })], CONFIG);
    expect(activities).toHaveLength(1);
    expect(skipped).toHaveLength(1); // the unrelated movimientos row itself is unmatched
    expect(skipped[0].source).toBe("movimientos");
  });
});

describe("cash-only movimientos rows", () => {
  it("maps custody/management fees and VAT to FEE", () => {
    for (const tipo of ["COMISION CUSTODIA MYINVESTOR", "COMISION GESTION CARTERA OF", "IVA SOBRE COMISIONES"]) {
      const { activities } = transform([], [movRow({ tipo, importe: "-2,48" })], CONFIG);
      expect(activities[0].activityType).toBe("FEE");
    }
  });

  it("maps LIQUIDAC. INTERESES to INTEREST", () => {
    const { activities } = transform([], [movRow({ tipo: "LIQUIDAC. INTERESES", importe: "+0,04" })], CONFIG);
    expect(activities[0].activityType).toBe("INTEREST");
  });

  it("maps CARGO RETENCION A CUENTA to TAX", () => {
    const { activities } = transform([], [movRow({ tipo: "CARGO RETENCION A CUENTA", importe: "-0,01" })], CONFIG);
    expect(activities[0].activityType).toBe("TAX");
  });

  it("maps ABONO PROMOCION to CREDIT with BONUS subtype", () => {
    const { activities } = transform([], [movRow({ tipo: "ABONO PROMOCION", importe: "+0,07" })], CONFIG);
    expect(activities[0].activityType).toBe("CREDIT");
    expect(activities[0].subtype).toBe("BONUS");
  });

  it("maps positive TRANSFERENCIA SEPA/INMEDIATA to DEPOSIT", () => {
    const { activities } = transform([], [movRow({ tipo: "TRANSFERENCIA SEPA", importe: "+50,00" })], CONFIG);
    expect(activities[0].activityType).toBe("DEPOSIT");
  });

  it("maps ABONO POR TRASPASO to DEPOSIT and CARGO POR TRASPASO to WITHDRAWAL (untracked cartera indexada)", () => {
    const abono = transform([], [movRow({ tipo: "ABONO POR TRASPASO", importe: "+2,41", concepto: "Aportacion a mi cartera" })], CONFIG);
    expect(abono.activities[0].activityType).toBe("DEPOSIT");
    const cargo = transform([], [movRow({ tipo: "CARGO POR TRASPASO", importe: "-1,90", concepto: "Reembolso cartera indexada" })], CONFIG);
    expect(cargo.activities[0].activityType).toBe("WITHDRAWAL");
  });

  it("skips APERTURA as informational", () => {
    const { activities, skipped } = transform([], [movRow({ tipo: "APERTURA", importe: "+0,00", concepto: "" })], CONFIG);
    expect(activities).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/no cash effect/i);
  });

  it("skips unknown movimientos types", () => {
    const { activities, skipped } = transform([], [movRow({ tipo: "SOMETHING NEW", importe: "+1,00" })], CONFIG);
    expect(activities).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/unknown movimientos type/i);
  });
});

describe("ordering", () => {
  it("assigns increasing lineNumber and unique timestamps for same-day activities", () => {
    const rows = [
      movRow({ tipo: "COMISION CUSTODIA MYINVESTOR", importe: "-1,00" }),
      movRow({ tipo: "LIQUIDAC. INTERESES", importe: "+0,01" }),
    ];
    const { activities } = transform([], rows, CONFIG);
    expect(activities).toHaveLength(2);
    expect(activities[0].lineNumber).toBe(1);
    expect(activities[1].lineNumber).toBe(2);
    expect(activities[0].date).not.toBe(activities[1].date);
  });
});

describe("Wealthfolio idempotency-key collisions", () => {
  // Wealthfolio's idempotency key hashes account+type+DATE-ONLY (time is
  // discarded)+asset+quantity+unitPrice+amount+fee+currency+description.
  // Same-day switch batches routinely split one traspaso into several
  // fragments landing on the exact same fund at the exact same NAV — two
  // fragments can have byte-identical quantity+price+comment on the same
  // day, which would silently collapse into a single activity without a
  // per-row disambiguating tag in the comment.
  it("gives two same-day/same-quantity/same-price BUY switch fragments distinct comments", () => {
    const fragA = fondosRow({
      operacion: "ALTA IIC SWITCH",
      numOperacion: "111",
      titulos: "3.23000000",
      precio: "10.4800000",
    });
    const fragB = fondosRow({
      operacion: "ALTA IIC SWITCH",
      numOperacion: "112",
      titulos: "3.23000000",
      precio: "10.4800000",
    });
    const { activities } = transform([fragA, fragB], [], CONFIG);
    expect(activities).toHaveLength(2);
    expect(activities[0].comment).not.toBe(activities[1].comment);
    expect(activities[0].comment).toContain("111");
    expect(activities[1].comment).toContain("112");
  });

  it("gives two same-day/same-amount DEPOSITs distinct comments", () => {
    const rows = [
      movRow({ tipo: "TRANSFERENCIA SEPA", concepto: "Paula", importe: "+50,00" }),
      movRow({ tipo: "TRANSFERENCIA SEPA", concepto: "Paula", importe: "+50,00" }),
    ];
    const { activities } = transform([], rows, CONFIG);
    expect(activities).toHaveLength(2);
    expect(activities[0].comment).not.toBe(activities[1].comment);
  });
});

describe("cross-addon transfer dedup", () => {
  it("skips a TRANSFERENCIA SEPA DEPOSIT that matches an existing cross-account TRANSFER_IN", () => {
    const row = movRow({ tipo: "TRANSFERENCIA SEPA", concepto: "From Trade Republic", importe: "+300,00" });
    const { activities, duplicates } = transform([], [row], CONFIG, [
      { date: "2026-01-06", amount: 300 },
    ]);
    expect(activities).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toMatch(/existing TRANSFER_IN/i);
  });

  it("still imports as DEPOSIT when no matching TRANSFER_IN exists", () => {
    const row = movRow({ tipo: "TRANSFERENCIA SEPA", importe: "+300,00" });
    const { activities } = transform([], [row], CONFIG, [{ date: "2026-01-06", amount: 999 }]);
    expect(activities).toHaveLength(1);
    expect(activities[0].activityType).toBe("DEPOSIT");
  });

  it("does not dedup a WITHDRAWAL against an existing TRANSFER_IN", () => {
    const row = movRow({ tipo: "TRANSFERENCIA SEPA", importe: "-300,00" });
    const { activities } = transform([], [row], CONFIG, [{ date: "2026-01-06", amount: 300 }]);
    expect(activities).toHaveLength(1);
    expect(activities[0].activityType).toBe("WITHDRAWAL");
  });

  it("does not dedup ABONO POR TRASPASO against an existing TRANSFER_IN (internal cartera indexada flow, not a bank transfer)", () => {
    const row = movRow({ tipo: "ABONO POR TRASPASO", importe: "+2,41", concepto: "Aportacion a mi cartera" });
    const { activities } = transform([], [row], CONFIG, [{ date: "2026-01-06", amount: 2.41 }]);
    expect(activities).toHaveLength(1);
    expect(activities[0].activityType).toBe("DEPOSIT");
  });

  it("flags an already-imported DEPOSIT as a real duplicate once a matching TRANSFER_IN shows up later", () => {
    // Reproduces the retroactive case: this DEPOSIT was created by an
    // earlier import, before the other addon's TRANSFER_IN existed to dedup
    // against. Re-importing the same movimientos history today should now
    // catch it, since both sides currently exist.
    const row = movRow({ tipo: "TRANSFERENCIA SEPA", concepto: "Paula", importe: "+100,00" });
    const { activities, duplicates } = transform(
      [],
      [row],
      CONFIG,
      [{ id: "transfer-1", date: "2026-01-06", amount: 100 }],
      [{ id: "deposit-1", date: "2026-01-06", amount: 100 }],
    );
    expect(activities).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toMatch(/real duplicate/i);
    expect(duplicates[0].reason).toContain("transfer-1");
    expect(duplicates[0].reason).toContain("deposit-1");
  });

  it("still just skips (no 'real duplicate' warning) when no matching DEPOSIT already exists", () => {
    const row = movRow({ tipo: "TRANSFERENCIA SEPA", importe: "+100,00" });
    const { duplicates } = transform(
      [],
      [row],
      CONFIG,
      [{ id: "transfer-1", date: "2026-01-06", amount: 100 }],
      [{ id: "deposit-1", date: "2026-01-06", amount: 999 }],
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).not.toMatch(/real duplicate/i);
  });
});
