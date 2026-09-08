import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseMyInvestorHtml } from "./parseFiles";
import { fxRateKey, transform } from "./transform";
import type { AddonSettings } from "./types";

// parseFiles.ts relies on a global DOMParser (as it would get for free in the
// happy-dom/browser test environment). This file stays on the default node
// environment instead — so node:fs works without Vite's browser-target
// externalization kicking in — and provides DOMParser manually, bound to a
// happy-dom Window (the standalone DOMParser export needs one internally).
(globalThis as { DOMParser?: unknown }).DOMParser = new Window().DOMParser;

// These fixtures are sanitized-but-structurally-faithful copies of real
// MyInvestor "Consulta de operaciones" (fondos) and "Cuenta > Corriente >
// Movimientos" (movimientos) exports: same ISO-8859-1 encoding, HTML
// boilerplate quirks (e.g. movimientos' duplicated <html>/<body> tags and
// Saldo Inicio/Final summary rows), x:num attributes, &nbsp; padding, and
// every operacion/tipo value seen in real exports — but with fabricated
// ISINs, fund names, amounts, and transfer concepts. No real personal data
// (names, IBANs, account numbers) is present. See README/CLAUDE.md for the
// export format background.
//
// The movimientos fixture uses the real 7-column shape (Cargo/Abono
// indicator + running Saldo, no Divisa column, and no share-count suffix in
// Concepto) — this is the only screen actually used for cuenta corriente
// exports; see parseMovimientos in parseFiles.ts. Because that Concepto
// format never embeds a share count, SUSCRIPCION/REEMBOLSO fund trades join
// to their cash counterpart by fund-name similarity instead (see
// findCashMatch/wordOverlapScore in transform.ts) — still deriving the
// exact cash-based unitPrice/fxRate, not a native-price guess.
function readFixture(name: string): string {
  const buffer = readFileSync(join(__dirname, "__fixtures__", name));
  return new TextDecoder("iso-8859-1").decode(buffer);
}

const CONFIG: AddonSettings = {
  accountId: "myinvestor",
  securityMappings: {},
};

describe("real-export fixtures", () => {
  const fondosHtml = readFixture("sample-fondos.xls");
  const movimientosHtml = readFixture("sample-movimientos.xls");

  it("decodes ISO-8859-1 accented headers correctly", () => {
    expect(fondosHtml).toContain("Títulos/NOMINAL");
    expect(fondosHtml).toContain("Liquidación");
    expect(movimientosHtml).toContain("Fecha operación");
  });

  it("auto-detects both files by header content", () => {
    const fondos = parseMyInvestorHtml(fondosHtml);
    const movimientos = parseMyInvestorHtml(movimientosHtml);
    expect(fondos.kind).toBe("fondos");
    expect(movimientos.kind).toBe("movimientos");
  });

  it("parses every row of both exports, tolerating movimientos' malformed nested <html>/<body> tags", () => {
    const fondos = parseMyInvestorHtml(fondosHtml);
    const movimientos = parseMyInvestorHtml(movimientosHtml);
    if (fondos.kind !== "fondos" || movimientos.kind !== "movimientos") throw new Error("wrong kind");
    expect(fondos.rows).toHaveLength(10);
    expect(movimientos.rows).toHaveLength(29);
  });

  describe("end-to-end transform", () => {
    const fondos = parseMyInvestorHtml(fondosHtml);
    const movimientos = parseMyInvestorHtml(movimientosHtml);
    if (fondos.kind !== "fondos" || movimientos.kind !== "movimientos") throw new Error("wrong kind");
    const { activities, skipped, fxRateWarnings } = transform(fondos.rows, movimientos.rows, CONFIG);

    it("produces the expected total activity/skip counts", () => {
      // 9 fund BUY/SELL (2 matched EUR/USD SUSCRIPCION/REEMBOLSO, both
      // matched by fund name since this movimientos shape carries no share
      // count + 1 SUSCRIPCION matched by fund name despite the two exports
      // wording the fund differently, disambiguated from a same-day decoy
      // by word-overlap score (see "picks the higher-scoring..." below) + 2
      // identical same-day traspaso-in fragments + 1 traspaso-out + ALTA/BAJA
      // IIC SWITCH pair — traspasos never had a cash counterpart to match in
      // the first place) + 5 direct securities BUY/SELL from movimientos
      // alone (2 stock buys, 1 stock sell, 1 Letra del Tesoro buy + its
      // amortizacion) + 1 DIVIDEND + 16 cash activities (5 FEE — including
      // the dividend-reversal FEE/REVERSAL — 1 INTEREST, 1 TAX, 1 CREDIT, 3
      // DEPOSIT, 5 WITHDRAWAL).
      expect(activities).toHaveLength(31);
      // APERTURA + a genuinely-unmatched fondos SUSCRIPCION (SAMPLE EMERGING
      // MARKETS — no counterpart in this movimientos export at all, by
      // shares or by name) + two genuinely-unmatched movimientos SUSCRIPCION
      // IIC rows (SAMPLE BOND FUND, and the decoy SAMPLE EUROPE BOND FUND —
      // no counterpart in fondos either). The fund pairs that DO have a real
      // counterpart now join by fund name instead of being left unlinked.
      expect(skipped).toHaveLength(4);
    });

    it("warns (but still books at native price) for the fixture's USD ALTA IIC SWITCH when no fxRates are supplied", () => {
      // No fxRates passed above, matching how a lookup failure/no-data
      // response degrades — the activity itself is unaffected.
      expect(fxRateWarnings).toHaveLength(1);
      expect(fxRateWarnings[0].reason).toMatch(/no historical usd→eur exchange rate/i);
      const alta = activities.find((a) => a.symbol === "IE00SAMPLE03" && a.quantity === "2.00000000");
      expect(alta?.fxRate).toBeUndefined();
      expect(alta?.currency).toBe("USD");
    });

    it("applies a resolved historical fxRate to that same USD ALTA IIC SWITCH row when supplied", () => {
      // Keyed by fechaLiquidacion (2026-06-03), not fechaOperacion (2026-06-01).
      const fxRates = { [fxRateKey("USD", "2026-06-03")]: 0.87 };
      const result = transform(fondos.rows, movimientos.rows, CONFIG, [], [], fxRates);
      expect(result.fxRateWarnings).toHaveLength(0);
      const alta = result.activities.find((a) => a.symbol === "IE00SAMPLE03" && a.quantity === "2.00000000");
      expect(alta?.fxRate).toBe("0.87");
    });

    it("matches SUSCRIPCION/REEMBOLSO by fund name (still deriving the exact cash price) since this movimientos shape carries no share count", () => {
      // Real cash debit was 53.69 for this fund's SUSCRIPCION — matched by
      // fund name (Concepto has no share count to match on in this shape),
      // and still derives the exact price from that real debit rather than
      // settling for MyInvestor's stated "Precio Neto" (11.6260000).
      const buy = activities.find((a) => a.symbol === "IE00SAMPLE01" && a.activityType === "BUY" && a.quantity === "4.61000000");
      expect(buy).toBeDefined();
      expect(buy?.fxRate).toBeUndefined();
      expect(parseFloat(String(buy?.unitPrice))).toBeCloseTo(53.69 / 4.61, 6);
    });

    it("computes an explicit fxRate for the USD-denominated SUSCRIPCION too, matched by fund name", () => {
      const buy = activities.find((a) => a.symbol === "IE00SAMPLE03" && a.activityType === "BUY" && a.quantity === "10.00000000");
      expect(buy).toBeDefined();
      expect(buy?.currency).toBe("USD");
      expect(buy?.fxRate).toBeDefined();
      expect(parseFloat(String(buy?.fxRate))).toBeCloseTo(230.5 / (10 * 25), 3);
    });

    it("picks the higher-scoring fund-name match over a same-day decoy sharing fewer words", () => {
      // IE00SAMPLE04's fondos nombre is "SAMPLE JAPAN INDEX FUND EUR"; its
      // real movimientos counterpart words it differently ("BRANDX SAMPLE
      // JAPAN INDEX FD" — brand prefix + abbreviation, mirroring a real
      // account's fondos/movimientos wording mismatch), sharing 3 words. A
      // decoy "SAMPLE EUROPE BOND FUND" row lands on the very same
      // tipo+date and shares 2 words with the same nombre — enough to be a
      // real candidate, but not the best one.
      const buy = activities.find((a) => a.symbol === "IE00SAMPLE04");
      expect(buy).toBeDefined();
      expect(buy?.activityType).toBe("BUY");
      // Real cash debit was 44.85, not MyInvestor's stated "Precio Neto"
      // (15.0000000) — proves the match resolved to the real counterpart,
      // not the decoy (which would derive a different price entirely).
      expect(parseFloat(String(buy?.unitPrice))).toBeCloseTo(44.85 / 3, 6);
      // The decoy itself is correctly left unmatched, not silently paired
      // with some other fondos row.
      const decoySkip = skipped.find((s) => s.description === "SAMPLE EUROPE BOND FUND");
      expect(decoySkip?.reason).toMatch(/no matching fund detail/i);
    });

    it("still flags movimientos SUSCRIPCION IIC rows with no real fondos counterpart, without blocking the matched ones above", () => {
      const movSkips = skipped.filter((s) => s.source === "movimientos" && s.type !== "APERTURA");
      expect(movSkips).toHaveLength(2);
      expect(movSkips.map((s) => s.description).sort()).toEqual(["SAMPLE BOND FUND EUR", "SAMPLE EUROPE BOND FUND"]);
      expect(movSkips.every((s) => s.reason.match(/no matching fund detail/i))).toBe(true);
      // The one fondos-side row with no real movimientos counterpart either
      // (SAMPLE EMERGING MARKETS) is flagged too now that matching actually
      // works for this shape — a real mismatch is worth surfacing rather
      // than silently booking an unverifiable native price.
      const fondosSkip = skipped.find((s) => s.source === "fondos");
      expect(fondosSkip?.description).toMatch(/SAMPLE EMERGING MARKETS/);
      expect(fondosSkip?.reason).toMatch(/no matching cash movement/i);
    });

    it("skips APERTURA as a no-op account marker", () => {
      expect(skipped.find((s) => s.type === "APERTURA")?.reason).toMatch(/no cash effect/i);
    });

    it("tags identical same-day traspaso-in fragments with distinct [ref:] comments so they don't collapse under Wealthfolio's description-based idempotency key", () => {
      const traspasoIns = activities.filter(
        (a) => a.symbol === "IE00SAMPLE01" && a.comment?.includes("fund switch (traspaso) in"),
      );
      expect(traspasoIns).toHaveLength(2);
      expect(traspasoIns[0].quantity).toBe(traspasoIns[1].quantity);
      expect(traspasoIns[0].unitPrice).toBe(traspasoIns[1].unitPrice);
      expect(traspasoIns[0].comment).not.toBe(traspasoIns[1].comment);
    });

    it("maps ALTA/BAJA IIC SWITCH to BUY/SELL like the SUSCR./REEMB. POR TRASPASO naming", () => {
      const alta = activities.find((a) => a.symbol === "IE00SAMPLE03" && a.quantity === "2.00000000");
      const baja = activities.find((a) => a.symbol === "IE00SAMPLE01" && a.quantity === "4.00000000");
      expect(alta?.activityType).toBe("BUY");
      expect(baja?.activityType).toBe("SELL");
    });

    it("maps every cash-only movimientos type to its expected activity type", () => {
      const byComment = (needle: string) => activities.find((a) => a.comment?.includes(needle));
      expect(byComment("COMISION CUSTODIA MYINVESTOR")?.activityType).toBe("FEE");
      expect(byComment("Cartera Indexada")?.activityType).toBe("FEE");
      expect(byComment("IVA gestion cartera")?.activityType).toBe("FEE");
      expect(byComment("Liquidacion intereses")?.activityType).toBe("INTEREST");
      expect(byComment("Retencion IRPF")?.activityType).toBe("TAX");
      expect(byComment("Bono bienvenida")?.activityType).toBe("CREDIT");
      expect(byComment("Sample Sender Uno")?.activityType).toBe("DEPOSIT");
      expect(byComment("Retirada a cuenta personal")?.activityType).toBe("WITHDRAWAL");
      expect(byComment("Aportacion a mi cartera")?.activityType).toBe("DEPOSIT");
      expect(byComment("Reembolso cartera indexada")?.activityType).toBe("WITHDRAWAL");
    });

    it("maps the Inversis-flavoured movimientos rows (securities, dividends, Letras del Tesoro)", () => {
      const byComment = (needle: string) => activities.find((a) => a.comment?.includes(needle));
      expect(byComment("COMISIONES CUSTODIA")?.activityType).toBe("FEE");

      const stockBuy = byComment("COMPRA RV CONTADO SF");
      expect(stockBuy?.activityType).toBe("BUY");
      expect(stockBuy?.symbol).toBe("SAMPLE TECH CORP");
      expect(stockBuy?.instrumentType).toBe("STOCK");
      expect(stockBuy?.quantity).toBe("20");
      expect(parseFloat(String(stockBuy?.unitPrice))).toBeCloseTo(2642 / 20, 6);

      expect(byComment("COMPRA RV CONTADO - SAMPLE SEMI INC")?.activityType).toBe("BUY");
      expect(byComment("VENTA DE VALORES")?.activityType).toBe("SELL");

      const letraBuy = byComment("COMPRA RF VCTO");
      expect(letraBuy?.activityType).toBe("BUY");
      expect(letraBuy?.instrumentType).toBe("BOND");
      expect(letraBuy?.symbol).toBe("SLTR 100726");
      const letraAmort = byComment("AMORTIZACION RF");
      expect(letraAmort?.activityType).toBe("SELL");
      expect(letraAmort?.instrumentType).toBe("BOND");

      const dividend = activities.find((a) => a.activityType === "DIVIDEND");
      expect(dividend?.symbol).toBe("SAMPLE SEMI INC");
      const dividendReversal = byComment("ANUL. SAMPLE SEMI INC");
      expect(dividendReversal?.activityType).toBe("FEE");
      expect(dividendReversal?.subtype).toBe("REVERSAL");

      expect(byComment("Sample Cena Amigos")?.activityType).toBe("WITHDRAWAL");
      expect(byComment("Sin concepto")?.activityType).toBe("DEPOSIT");
      expect(byComment("SAMPLE SHOP ONLINE")?.activityType).toBe("WITHDRAWAL");
      expect(byComment("Sample Beneficiario Dos")?.activityType).toBe("WITHDRAWAL");
    });
  });
});
