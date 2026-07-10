import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseMyInvestorHtml } from "./parseFiles";
import { transform } from "./transform";
import type { AddonSettings } from "./types";

// parseFiles.ts relies on a global DOMParser (as it would get for free in the
// happy-dom/browser test environment). This file stays on the default node
// environment instead — so node:fs works without Vite's browser-target
// externalization kicking in — and provides DOMParser manually, bound to a
// happy-dom Window (the standalone DOMParser export needs one internally).
(globalThis as { DOMParser?: unknown }).DOMParser = new Window().DOMParser;

// These fixtures are sanitized-but-structurally-faithful copies of real
// MyInvestor "Consulta de operaciones" (fondos) and "Movimientos" exports:
// same ISO-8859-1 encoding, HTML boilerplate quirks (e.g. movimientos'
// duplicated <html>/<body> tags), x:num attributes, &nbsp; padding, and every
// operacion/tipo value seen in real exports — but with fabricated ISINs,
// fund names, amounts, and transfer concepts. No real personal data (names,
// IBANs, account numbers) is present. See README/CLAUDE.md for the export
// format background.
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
    expect(fondos.rows).toHaveLength(9);
    expect(movimientos.rows).toHaveLength(15);
  });

  describe("end-to-end transform", () => {
    const fondos = parseMyInvestorHtml(fondosHtml);
    const movimientos = parseMyInvestorHtml(movimientosHtml);
    if (fondos.kind !== "fondos" || movimientos.kind !== "movimientos") throw new Error("wrong kind");
    const { activities, skipped } = transform(fondos.rows, movimientos.rows, CONFIG);

    it("produces the expected total activity/skip counts", () => {
      // 8 fund BUY/SELL (2 matched + 2 identical same-day traspaso-in
      // fragments + 1 traspaso-out + ALTA/BAJA IIC SWITCH pair) + 10 cash
      // activities (3 FEE, 1 INTEREST, 1 TAX, 1 CREDIT, 2 DEPOSIT, 2 WITHDRAWAL).
      expect(activities).toHaveLength(18);
      // 1 unmatched fondos SUSCRIPCION + 1 unmatched movimientos SUSCRIPCION IIC + 1 APERTURA.
      expect(skipped).toHaveLength(3);
    });

    it("merges the matched EUR SUSCRIPCION and derives unitPrice from the real cash debit", () => {
      const buy = activities.find((a) => a.symbol === "IE00SAMPLE01" && a.activityType === "BUY" && a.quantity === "4.61000000");
      expect(buy).toBeDefined();
      expect(buy?.fxRate).toBeUndefined();
      expect(parseFloat(String(buy?.unitPrice))).toBeCloseTo(53.69 / 4.61, 6);
    });

    it("computes an explicit fxRate for the USD-denominated SUSCRIPCION", () => {
      const buy = activities.find((a) => a.symbol === "IE00SAMPLE03" && a.activityType === "BUY" && a.quantity === "10.00000000");
      expect(buy).toBeDefined();
      expect(buy?.currency).toBe("USD");
      expect(buy?.fxRate).toBeDefined();
      expect(parseFloat(String(buy?.fxRate))).toBeCloseTo(230.5 / (10 * 25), 6);
    });

    it("flags the unmatched fondos SUSCRIPCION and the unmatched movimientos SUSCRIPCION IIC independently", () => {
      expect(skipped.find((s) => s.source === "fondos")?.reason).toMatch(/no matching cash movement/i);
      expect(skipped.find((s) => s.source === "movimientos" && s.type === "SUSCRIPCION IIC")?.reason).toMatch(
        /no matching fund detail/i,
      );
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
  });
});
