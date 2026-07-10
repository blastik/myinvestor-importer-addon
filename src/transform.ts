import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type {
  AddonSettings,
  ExistingCashTransferIn,
  FondosRow,
  MovimientosRow,
  SkippedRow,
  TransformResult,
} from "./types";
import { fondosNum, movimientosNum } from "./parseFiles";

// A bank transfer recorded in movimientos and a cross-addon TRANSFER_IN are
// considered the same real-world money movement when the amount matches
// exactly and the dates are within a day (the two systems can record the
// settlement day slightly differently).
function matchesExistingTransferIn(
  existing: ExistingCashTransferIn[],
  date: string,
  amount: number,
): boolean {
  const dayMs = 24 * 60 * 60 * 1000;
  const target = new Date(date).getTime();
  return existing.some(
    (e) => Math.abs(e.amount - amount) < 0.005 && Math.abs(new Date(e.date).getTime() - target) <= dayMs,
  );
}

const CASH_SYMBOL = "$CASH-EUR";

function fmtAmt(n: number): string {
  const abs = Math.abs(n);
  const str = abs.toFixed(6);
  return str.replace(/\.?0+$/, "") || "0";
}

function cashAct(
  accountId: string,
  activityType: string,
  day: string,
  orderHint: string,
  amount: number,
  comment: string,
  subtype?: string,
): Draft {
  return {
    day,
    orderHint,
    activity: {
      accountId,
      activityType: activityType as ActivityImport["activityType"],
      subtype,
      symbol: CASH_SYMBOL,
      quantity: "1",
      unitPrice: "1",
      amount: fmtAmt(amount),
      currency: "EUR",
      comment,
      isValid: true,
      isDraft: false,
    },
  };
}

interface Draft {
  day: string;
  orderHint: string;
  activity: ActivityImport;
}

// Trailing "@ 0.855" in a movimientos concepto is the fund's share count for
// that SUSCRIPCION IIC / REEMBOLSO IIC row — the join key back to the fondos
// file (which carries the ISIN this file omits).
function conceptShares(concepto: string): number | undefined {
  const at = concepto.lastIndexOf("@");
  if (at === -1) return undefined;
  const n = parseFloat(concepto.slice(at + 1).trim());
  return Number.isNaN(n) ? undefined : n;
}

function findCashMatch(
  pool: { row: MovimientosRow; index: number; consumed: boolean }[],
  expectedTipo: string,
  fechaLiquidacion: string,
  titulos: number,
  nombre: string,
): { row: MovimientosRow; index: number; consumed: boolean } | undefined {
  const candidates = pool.filter(
    (p) =>
      !p.consumed &&
      p.row.tipo === expectedTipo &&
      p.row.fechaValor === fechaLiquidacion &&
      Math.abs((conceptShares(p.row.concepto) ?? NaN) - titulos) < 0.001,
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  // Disambiguate same-day/same-share-count coincidences by fund name prefix.
  const namePrefix = nombre.split(" ")[0]?.toUpperCase() ?? "";
  const byName = candidates.find((c) => c.row.concepto.toUpperCase().startsWith(namePrefix));
  return byName ?? candidates[0];
}

export function transform(
  fondosRows: FondosRow[],
  movimientosRows: MovimientosRow[],
  config: AddonSettings,
  existingCashTransfersIn: ExistingCashTransferIn[] = [],
): TransformResult {
  const { accountId } = config;
  const drafts: Draft[] = [];
  const skipped: SkippedRow[] = [];

  const cashPool = movimientosRows.map((row, index) => ({ row, index, consumed: false }));

  for (const r of fondosRows) {
    const titulos = fondosNum(r.titulos);
    const precio = fondosNum(r.precio);
    const instrumentType = "FUND";
    const orderHint = r.numOperacion.trim().padStart(12, "0");

    if (r.operacion === "SUSCRIPCION" || r.operacion === "REEMBOLSO") {
      const isBuy = r.operacion === "SUSCRIPCION";
      const expectedTipo = isBuy ? "SUSCRIPCION IIC" : "REEMBOLSO IIC";
      const match = findCashMatch(cashPool, expectedTipo, r.fechaLiquidacion, titulos, r.nombre);

      let fxRate: string | undefined;
      let unitPrice = r.precio;
      if (match) {
        match.consumed = true;
        const eurAmount = Math.abs(movimientosNum(match.row.importe));
        if (r.divisa !== "EUR") {
          // Wealthfolio only honors fxRate when activity currency !=
          // account currency (verified in handlers/trades.rs) — this is
          // the USD case, where it does apply and books cash in EUR exactly.
          const nativeCost = titulos * precio;
          if (nativeCost !== 0) fxRate = String(eurAmount / nativeCost);
        } else if (titulos !== 0) {
          // EUR activity currency == EUR account currency, so fxRate would
          // be silently ignored (same source) and cash always books as
          // quantity * unitPrice. MyInvestor's stated "Precio Neto" has a
          // small residual vs. the actual EUR debited (NAV rounding), which
          // is immaterial per-trade but accumulates across hundreds of
          // trades into a real balance mismatch. Deriving the unit price
          // from the real cash amount instead (quantity stays the true
          // titulos) makes quantity * unitPrice exactly match the ledger,
          // at the cost of a negligible per-lot cost-basis deviation from
          // MyInvestor's own stated price.
          unitPrice = String(eurAmount / titulos);
        }
      } else if (movimientosRows.length > 0) {
        // The movimientos file was provided but has no counterpart for this
        // row — a real data mismatch, surface it instead of guessing.
        skipped.push({
          date: r.fechaOperacion,
          source: "fondos",
          type: r.operacion,
          description: `${r.nombre} (${r.isin})`,
          reason: "No matching cash movement found in the movimientos export for this transaction",
        });
        continue;
      }
      // else: movimientos file wasn't uploaded — fall back to native-currency
      // booking (no fxRate), still useful for reviewing fund-level detail.

      drafts.push({
        day: r.fechaOperacion,
        orderHint,
        activity: {
          accountId,
          activityType: isBuy ? "BUY" : "SELL",
          symbol: r.isin,
          symbolName: r.nombre,
          instrumentType,
          quoteCcy: r.divisa,
          quantity: r.titulos,
          unitPrice,
          fee: "0",
          currency: r.divisa,
          fxRate,
          comment: `${r.nombre} - ${r.operacion}`,
          isValid: true,
          isDraft: false,
        },
      });
      continue;
    }

    // Fund switches (traspasos) are modeled as BUY/SELL at the switch-day
    // price, not TRANSFER_IN/TRANSFER_OUT. TRANSFER_IN unconditionally adds
    // its value to Wealthfolio's net_contribution ("invested") figure
    // regardless of pairing (confirmed in handlers/transfers.rs) — treating
    // an internal fund-to-fund exchange as if it were fresh external
    // capital. Pairing via a shared sourceGroupId doesn't fix this safely
    // either: a grouped TRANSFER_IN reattaches the paired TRANSFER_OUT's
    // cached Lot objects verbatim, which for a cross-asset switch would
    // silently give the new fund the OLD fund's quantity/cost-basis instead
    // of its own. BUY/SELL never touch net_contribution at all (not
    // referenced in handlers/trades.rs) and need no pairing, so this is the
    // only option that's both accurate and simple. Trade-off: each switch
    // shows as a realized gain/loss in performance/tax reports even though
    // it's not a taxable event in Spain (traspasos are tax-deferred there).
    if (r.operacion === "SUSCR.POR TRASPASO I" || r.operacion === "ALTA IIC SWITCH") {
      drafts.push({
        day: r.fechaOperacion,
        orderHint,
        activity: {
          accountId,
          activityType: "BUY",
          symbol: r.isin,
          symbolName: r.nombre,
          instrumentType,
          quoteCcy: r.divisa,
          quantity: r.titulos,
          unitPrice: r.precio,
          fee: "0",
          currency: r.divisa,
          comment: `${r.nombre} - fund switch (traspaso) in`,
          isValid: true,
          isDraft: false,
        },
      });
      continue;
    }

    if (r.operacion === "REEMB.POR TRASPASO I" || r.operacion === "BAJA IIC SWITCH") {
      drafts.push({
        day: r.fechaOperacion,
        orderHint,
        activity: {
          accountId,
          activityType: "SELL",
          symbol: r.isin,
          symbolName: r.nombre,
          instrumentType,
          quoteCcy: r.divisa,
          quantity: r.titulos,
          unitPrice: r.precio,
          fee: "0",
          currency: r.divisa,
          comment: `${r.nombre} - fund switch (traspaso) out`,
          isValid: true,
          isDraft: false,
        },
      });
      continue;
    }

    skipped.push({
      date: r.fechaOperacion,
      source: "fondos",
      type: r.operacion,
      description: `${r.nombre} (${r.isin})`,
      reason: `Unknown fondos operation type: ${r.operacion}`,
    });
  }

  for (const entry of cashPool) {
    if (entry.consumed) continue;
    const r = entry.row;
    const amt = movimientosNum(r.importe);
    const absAmt = Math.abs(amt);
    const orderHint = `z${String(entry.index).padStart(10, "0")}`; // sort after same-day fondos rows

    if (r.tipo === "APERTURA") {
      skipped.push({
        date: r.fechaOperacion,
        source: "movimientos",
        type: r.tipo,
        description: r.concepto,
        reason: "APERTURA: account-opening marker, no cash effect",
      });
      continue;
    }

    if (r.tipo === "SUSCRIPCION IIC" || r.tipo === "REEMBOLSO IIC") {
      skipped.push({
        date: r.fechaOperacion,
        source: "movimientos",
        type: r.tipo,
        description: r.concepto,
        reason: "No matching fund detail found in the fondos export for this transaction",
      });
      continue;
    }

    if (r.tipo === "COMISION CUSTODIA MYINVESTOR" || r.tipo === "COMISION GESTION CARTERA OF" || r.tipo === "IVA SOBRE COMISIONES") {
      drafts.push(cashAct(accountId, "FEE", r.fechaOperacion, orderHint, absAmt, r.tipo + (r.concepto ? ` - ${r.concepto}` : "")));
      continue;
    }

    if (r.tipo === "LIQUIDAC. INTERESES") {
      drafts.push(cashAct(accountId, "INTEREST", r.fechaOperacion, orderHint, absAmt, r.concepto));
      continue;
    }

    if (r.tipo === "CARGO RETENCION A CUENTA") {
      drafts.push(cashAct(accountId, "TAX", r.fechaOperacion, orderHint, absAmt, r.concepto));
      continue;
    }

    if (r.tipo === "ABONO PROMOCION") {
      drafts.push(cashAct(accountId, "CREDIT", r.fechaOperacion, orderHint, absAmt, r.concepto, "BONUS"));
      continue;
    }

    if (r.tipo === "TRANSFERENCIA SEPA" || r.tipo === "TRANSFERENCIA INMEDIATA") {
      // A bank transfer in is often also recorded as a TRANSFER_IN by
      // whichever addon manages the source account (e.g.
      // trade-republic-importer-addon's Transfer Patterns) — importing it
      // again here as a DEPOSIT would double-count the same money as both
      // spending on that side and external income on this side.
      if (amt >= 0 && matchesExistingTransferIn(existingCashTransfersIn, r.fechaOperacion, absAmt)) {
        skipped.push({
          date: r.fechaOperacion,
          source: "movimientos",
          type: r.tipo,
          description: r.concepto,
          reason:
            "Matches an existing TRANSFER_IN of the same amount around this date in this account — " +
            "likely already recorded by another addon/import; not creating a duplicate DEPOSIT",
        });
        continue;
      }
      drafts.push(
        cashAct(accountId, amt >= 0 ? "DEPOSIT" : "WITHDRAWAL", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo),
      );
      continue;
    }

    if (r.tipo === "ABONO POR TRASPASO") {
      drafts.push(
        cashAct(accountId, amt >= 0 ? "DEPOSIT" : "WITHDRAWAL", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo),
      );
      continue;
    }

    if (r.tipo === "CARGO POR TRASPASO") {
      drafts.push(cashAct(accountId, "WITHDRAWAL", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo));
      continue;
    }

    skipped.push({
      date: r.fechaOperacion,
      source: "movimientos",
      type: r.tipo,
      description: r.concepto,
      reason: `Unknown movimientos type: ${r.tipo}`,
    });
  }

  // Deterministic same-day ordering: sort by (day, orderHint).
  drafts.sort((a, b) => (a.day === b.day ? a.orderHint.localeCompare(b.orderHint) : a.day.localeCompare(b.day)));

  // Wealthfolio's idempotency key hashes account+type+DATE-ONLY (time is
  // discarded)+asset+quantity+unitPrice+amount+fee+currency+description —
  // never a per-row id. MyInvestor's traspaso/switch batches routinely split
  // one transfer into several same-day fragments that land on the exact same
  // fund at the exact same NAV (identical quantity AND price), and duplicate
  // same-day/same-amount deposits happen too — those rows are byte-identical
  // on every hashed field, so without a distinguishing tag here they silently
  // collapse into one activity, dropping real shares/cash with no error
  // surfaced anywhere. `orderHint` is unique per source row (fondos
  // numOperacion, or file index for movimientos-only rows) and stable across
  // re-imports of the same export, so tagging the description with it fixes
  // the collision while still letting genuine re-imports be recognised as
  // duplicates rather than re-created.
  let dayCursor = "";
  let secondsInDay = 0;
  const activities: ActivityImport[] = drafts.map((d) => {
    if (d.day !== dayCursor) {
      dayCursor = d.day;
      secondsInDay = 0;
    }
    const hh = String(Math.floor(secondsInDay / 3600)).padStart(2, "0");
    const mm = String(Math.floor((secondsInDay % 3600) / 60)).padStart(2, "0");
    const ss = String(secondsInDay % 60).padStart(2, "0");
    secondsInDay += 1;
    return {
      ...d.activity,
      date: `${d.day}T${hh}:${mm}:${ss}.000Z`,
      comment: `${d.activity.comment} [ref:${d.orderHint}]`,
    };
  });
  activities.forEach((a, i) => {
    a.lineNumber = i + 1;
  });

  return { activities, skipped };
}
