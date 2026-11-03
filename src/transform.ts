import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type {
  AddonSettings,
  ConversionBatchInfo,
  ExistingCashTransferIn,
  ExistingDeposit,
  FondosRow,
  MovimientosRow,
  SkippedRow,
  TransformResult,
} from "./types";
import { fondosNum, movimientosNum, movimientosRowKey } from "./parseFiles";
import {
  BATCH_WINDOW_DAYS,
  CONVERSION_GROUP_PREFIX,
  allocateBatch,
  batchCurrencyIssue,
  batchLegs,
  conversionRef,
  legValue,
  normalizeNumOp,
  traspasoDirection,
  type PlannedConversion,
  type TraspasoLeg,
} from "./conversions";

// A bank transfer recorded in movimientos and a cross-addon TRANSFER_IN (or
// an already-imported DEPOSIT from an earlier run of this addon) are
// considered the same real-world money movement when the amount matches
// exactly and the dates are within a day (the two systems/imports can record
// the settlement day slightly differently).
function findAmountDateMatch<T extends { date: string; amount: number }>(
  existing: T[],
  date: string,
  amount: number,
): T | undefined {
  const dayMs = 24 * 60 * 60 * 1000;
  const target = new Date(date).getTime();
  return existing.find(
    (e) => Math.abs(e.amount - amount) < 0.005 && Math.abs(new Date(e.date).getTime() - target) <= dayMs,
  );
}

const CASH_SYMBOL = "$CASH-EUR";

// 32-bit FNV-1a, hex. Only needs to be stable and well-spread, not secure.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

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
  // Index of the switch batch a conversion row belongs to (planTraspasos).
  batch?: number;
}

function sortDrafts(drafts: Draft[]): void {
  drafts.sort((a, b) => (a.day === b.day ? a.orderHint.localeCompare(b.orderHint) : a.day.localeCompare(b.day)));
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

function conceptInstrument(concepto: string): { symbol: string; quantity?: number } {
  const at = concepto.lastIndexOf("@");
  if (at === -1) return { symbol: concepto.trim().replace(/\s+/g, " ") || "UNKNOWN" };
  const symbol = concepto
    .slice(0, at)
    .trim()
    .replace(/\s+/g, " ");
  const quantity = movimientosNum(concepto.slice(at + 1).trim());
  return {
    symbol: symbol || "UNKNOWN",
    quantity: Number.isNaN(quantity) ? undefined : quantity,
  };
}

// Key format shared with ImportPage.tsx: it builds this same key from
// exchangeRates.getRatesForDates results so transform() can look resolved
// rates back up per (native currency, settlement date — see traspasoFxRate).
export function fxRateKey(currency: string, date: string): string {
  return `${currency}|${date}`;
}

// Fund switches (traspasos) settle at the fund's native price with no
// movimientos cash counterpart to derive a real EUR rate from (see
// SUSCRIPCION/REEMBOLSO above, which does have one). A non-EUR switch needs
// a real EUR/native historical rate instead, looked up by the caller via
// ctx.api.exchangeRates.getRatesForDates and passed in as `fxRates`.
export function isForeignTraspaso(r: FondosRow): boolean {
  return (
    r.divisa !== "EUR" &&
    (r.operacion === "SUSCR.POR TRASPASO I" ||
      r.operacion === "ALTA IIC SWITCH" ||
      r.operacion === "REEMB.POR TRASPASO I" ||
      r.operacion === "BAJA IIC SWITCH")
  );
}

// Keyed by fechaLiquidacion (settlement), not fechaOperacion (order date) —
// matching how the SUSCRIPCION/REEMBOLSO branch above already matches cash by
// settlement date (findCashMatch against movimientos' fechaValor). A switch's
// actual currency conversion happens when it clears, not when it's ordered,
// and real MyInvestor data shows those dates diverging by up to a week (e.g.
// an order on a Friday settling the following Friday) — during which
// EUR/USD can move enough to matter. Looking the rate up by order date was
// confirmed to add avoidable drift on top of the inherent approximation
// (an external historical rate is never exactly Inversis' own internal
// conversion rate for that trade) when reconciling a real ~2.9-year account:
// switching to fechaLiquidacion doesn't make the reconciliation exact, but
// removes this compounding source of error.
function traspasoFxRate(
  r: FondosRow,
  fxRates: Record<string, number>,
  fxRateWarnings: SkippedRow[],
): string | undefined {
  if (r.divisa === "EUR") return undefined;
  const rate = fxRates[fxRateKey(r.divisa, r.fechaLiquidacion)];
  if (rate != null && Number.isFinite(rate) && rate > 0) return String(rate);
  fxRateWarnings.push({
    date: r.fechaOperacion,
    source: "fondos",
    type: r.operacion,
    description: `${r.nombre} (${r.isin})`,
    reason: `No historical ${r.divisa}→EUR exchange rate available for ${r.fechaLiquidacion} (settlement) — booked at the native switch price with no fxRate; will land in an unfunded ${r.divisa} cash bucket until this is corrected manually`,
  });
  return undefined;
}

// A switch has no cash counterpart, so its value comes from the fondos row
// alone — and the broker's own "Importe neto" is what actually moved, not
// titulos × precio. The two agree to the cent on almost every row, but not
// all: some legs carry an importe several percent away from titulos ×
// precio (seen on both EUR and USD legs). Valuing switches at titulos ×
// precio made a full switch history no longer net to zero across its legs,
// leaving a phantom cash surplus/deficit in the account; valuing them at
// importe brings it back to within the inherent FX-rate approximation.
// Quantity is untouched (it's the real share count), only the per-unit
// price is derived from importe.
function traspasoUnitPrice(r: FondosRow): string {
  const titulos = fondosNum(r.titulos);
  const importe = fondosNum(r.importe);
  if (titulos > 0 && importe > 0) return String(importe / titulos);
  return r.precio;
}

// How many whole words fondos' `nombre` and movimientos' `concepto` have in
// common (case-insensitive). The two export screens name the same fund
// differently — confirmed against a real account: fondos' "MSCI JAPAN INDEX
// P ACC EUR" vs movimientos' "FIDELITY MSCI JAPAN INDEX P AC" for the same
// real fund, where movimientos adds a brand prefix and abbreviates "ACC" to
// "AC" — so neither a `startsWith` nor an exact match is reliable; counting
// shared words tolerates that while still telling genuinely different funds
// apart (e.g. "ISHARES EMERGING..." vs "ISHARES DEVELOPED..." only share
// the brand word, scoring far lower than a true match).
function wordOverlapScore(nombre: string, concepto: string): number {
  const nombreWords = nombre.toUpperCase().split(/\s+/).filter(Boolean);
  const conceptoWords = new Set(concepto.toUpperCase().split(/\s+/).filter(Boolean));
  return nombreWords.filter((w) => conceptoWords.has(w)).length;
}

// Whether a movimientos EUR amount can be the cash side of a fondos trade
// worth `nativeCost` (titulos × precio, in the fund's own currency). For EUR
// funds the two differ only by NAV rounding (a few cents), so the tolerance
// is tight: 3% or 2 cents, whichever is larger (tiny trades round to whole
// cents). For other currencies the EUR amount also includes the FX
// conversion, so only gross mismatches are rejected.
function plausibleCashAmount(eurAmount: number, nativeCost: number, divisa: string): boolean {
  if (!(nativeCost > 0)) return true;
  if (divisa === "EUR") return Math.abs(eurAmount - nativeCost) <= Math.max(0.02, nativeCost * 0.03);
  const ratio = eurAmount / nativeCost;
  return ratio > 0.5 && ratio < 2;
}

// A real MyInvestor account's movimientos history is not always homogeneous
// on this point: confirmed against a real multi-year account that some
// SUSCRIPCION IIC/REEMBOLSO IIC rows carry a share-count suffix in Concepto
// ("... EUR @ 12.6") and others from the very same export/account don't
// ("... EUR" with nothing after it, or no "@" at all) — this can vary
// row-by-row within one account's history, not just across different
// accounts/screen versions. So matching tries the precise share-count join
// first, per row, and only falls back to fund-name similarity (see
// wordOverlapScore) when no share count is available or none lines up —
// rather than a dataset-wide switch that would give up on shares entirely
// just because one row happened to lack them.
function findCashMatch(
  pool: { row: MovimientosRow; index: number; consumed: boolean }[],
  expectedTipo: string,
  fechaLiquidacion: string,
  titulos: number,
  nombre: string,
  nativeCost: number,
  divisa: string,
): { row: MovimientosRow; index: number; consumed: boolean } | undefined {
  const sameTipoDate = pool.filter(
    (p) => !p.consumed && p.row.tipo === expectedTipo && p.row.fechaValor === fechaLiquidacion,
  );
  if (sameTipoDate.length === 0) return undefined;

  const shareMatches = sameTipoDate.filter(
    (p) => Math.abs((conceptShares(p.row.concepto) ?? NaN) - titulos) < 0.001,
  );
  if (shareMatches.length === 1) return shareMatches[0];
  if (shareMatches.length > 1) {
    // Disambiguate same-day/same-share-count coincidences by the closest
    // fund-name match — share count already agrees, so this is just a
    // tie-break, not the primary signal.
    return shareMatches.reduce((best, c) =>
      wordOverlapScore(nombre, c.row.concepto) > wordOverlapScore(nombre, best.row.concepto) ? c : best,
    );
  }

  // No share-count match at all — fall back to fund-name similarity alone,
  // still scoped to the same tipo+date, and only among candidates whose cash
  // amount is plausible for this trade (see plausibleCashAmount). Without
  // that filter, generic words every fund name shares ("ACC", "EUR",
  // "INDEX", "P") were enough to match a trade to a *different* fund's cash
  // row whenever its real counterpart wasn't in the uploaded movimientos
  // export (e.g. one that ends partway through a day), booking the trade at
  // a wildly wrong price. Require an unambiguous, non-zero
  // winner: a lone candidate that shares no words with `nombre` (a
  // coincidental different fund settling the same day) is correctly left
  // unmatched rather than guessed.
  const scored = sameTipoDate
    .filter((c) => plausibleCashAmount(Math.abs(movimientosNum(c.row.importe)), nativeCost, divisa))
    .map((c) => ({ c, score: wordOverlapScore(nombre, c.row.concepto) }));
  if (scored.length === 0) return undefined;
  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore === 0) return undefined;
  const winners = scored.filter((s) => s.score === maxScore);
  return winners.length === 1 ? winners[0].c : undefined;
}

// A switch leg booked as a plain BUY/SELL at the switch-day price: the
// fallback for legs that can't be part of a conversion (see planTraspasos).
//
// History: switches were first TRANSFER_IN/TRANSFER_OUT (inflated
// net_contribution — TRANSFER_IN adds its value unconditionally; grouping
// them would graft the old fund's lots onto the new one), then BUY/SELL for
// every switch (correct holdings and net_contribution, but a phantom
// realized gain/loss per switch, though traspasos are tax-deferred in
// Spain). Wealthfolio 3.12 conversions fix that last part; BUY/SELL remains
// for what they can't express yet. See CLAUDE.md before changing this.
//
// A non-EUR leg also needs an explicit fxRate (traspasoFxRate) — without it
// Wealthfolio books cash into a separate, never-funded currency bucket
// instead of the account's real EUR cash.
function traspasoTradeDraft(
  r: FondosRow,
  accountId: string,
  fxRates: Record<string, number>,
  fxRateWarnings: SkippedRow[],
): Draft {
  const isIn = traspasoDirection(r.operacion) === "in";
  return {
    day: r.fechaOperacion,
    orderHint: r.numOperacion.trim().padStart(12, "0"),
    activity: {
      accountId,
      activityType: isIn ? "BUY" : "SELL",
      symbol: r.isin,
      symbolName: r.nombre,
      instrumentType: "FUND",
      quoteCcy: r.divisa,
      quantity: r.titulos,
      unitPrice: traspasoUnitPrice(r),
      fee: "0",
      currency: r.divisa,
      fxRate: traspasoFxRate(r, fxRates, fxRateWarnings),
      comment: `${r.nombre} - fund switch (traspaso) ${isIn ? "in" : "out"}`,
      isValid: true,
      isDraft: false,
    },
  };
}

// The two rows of one conversion. Both are dated on the arrival day
// (Wealthfolio pairs them only on one business day) and carry units only:
// no price, amount, fee or fxRate. The "c" orderHint sorts them after
// same-day fondos trades (numeric hints) and before cash rows ("z"), and the
// stable sort keeps OUT and IN adjacent.
function conversionDrafts(p: PlannedConversion, accountId: string, batch: number): Draft[] {
  const sourceGroupId = CONVERSION_GROUP_PREFIX + p.ref;
  const label = `${p.outRow.nombre} → ${p.inRow.nombre} - fund switch (traspaso)`;
  const row = (dir: "out" | "in"): Draft => {
    const r = dir === "out" ? p.outRow : p.inRow;
    return {
      day: p.day,
      orderHint: p.ref,
      batch,
      activity: {
        accountId,
        activityType: "ADJUSTMENT",
        subtype: dir === "out" ? "CONVERSION_OUT" : "CONVERSION_IN",
        symbol: r.isin,
        symbolName: r.nombre,
        instrumentType: "FUND",
        quoteCcy: r.divisa,
        quantity: dir === "out" ? p.outUnits : p.inUnits,
        currency: r.divisa,
        sourceGroupId,
        comment: `${label} ${dir}`,
        isValid: true,
        isDraft: false,
      },
    };
  };
  return [row("out"), row("in")];
}

// Replays every fund activity in final order, per symbol, and returns the
// batches with a conversion whose leaving units exceed what is held at that
// point. Wealthfolio rejects such a pair as a whole — and the fund it would
// have credited is then missing for the next switch out of it, so one bad
// pair cascades — and only reports it in Health after the import. Demoting
// the batch to BUY/SELL here keeps holdings right instead.
function unitShortfalls(sorted: Draft[]): Map<number, string> {
  const held = new Map<string, number>();
  const failures = new Map<number, string>();
  for (const d of sorted) {
    const a = d.activity;
    if (!a.symbol || a.symbol === CASH_SYMBOL) continue;
    const qty = parseFloat(String(a.quantity ?? "0"));
    if (!Number.isFinite(qty)) continue;
    const current = held.get(a.symbol) ?? 0;
    if (a.activityType === "BUY" || a.subtype === "CONVERSION_IN") {
      held.set(a.symbol, current + qty);
    } else if (a.activityType === "SELL") {
      held.set(a.symbol, current - qty);
    } else if (a.subtype === "CONVERSION_OUT") {
      if (current + 1e-6 < qty && d.batch != null && !failures.has(d.batch)) {
        failures.set(
          d.batch,
          `the uploaded history holds only ${fmtAmt(Math.max(current, 0))} units of ${a.symbolName ?? a.symbol} on ` +
            `${d.day}, fewer than the ${fmtAmt(qty)} this switch moves out — upload the full fondos history to convert it`,
        );
      }
      held.set(a.symbol, current - qty);
    }
  }
  return failures;
}

interface TraspasoPlan {
  drafts: Draft[];
  fxRateWarnings: SkippedRow[];
  warnings: SkippedRow[];
  batches: (Omit<ConversionBatchInfo, "lineNumbers"> & { index: number })[];
}

// Turns the fondos switch legs into conversions where Wealthfolio can pair
// them, and BUY/SELL (traspasoTradeDraft) where it can't: legs that don't
// balance against an opposite leg within BATCH_WINDOW_DAYS, cross-currency
// switches, and batches whose leaving units this import doesn't show as held
// (unitShortfalls). See conversions.ts for the batching and allocation rules.
function planTraspasos(
  rows: FondosRow[],
  otherDrafts: Draft[],
  accountId: string,
  fxRates: Record<string, number>,
): TraspasoPlan {
  const legs: TraspasoLeg[] = rows.map((row) => ({
    row,
    dir: traspasoDirection(row.operacion)!,
    numOp: normalizeNumOp(row.numOperacion),
    value: legValue(row, fxRates[fxRateKey(row.divisa, row.fechaLiquidacion)]),
  }));
  const { batches, released } = batchLegs(legs);

  const demoted = new Map<number, string>();
  const plans = batches.map((b, i) => {
    const currencyIssue = batchCurrencyIssue(b);
    if (currencyIssue) {
      demoted.set(i, currencyIssue);
      return [];
    }
    const planned = allocateBatch(b);
    if (typeof planned === "string") {
      demoted.set(i, planned);
      return [];
    }
    return planned;
  });

  for (;;) {
    const fxRateWarnings: SkippedRow[] = [];
    const drafts: Draft[] = [];
    for (const leg of released) drafts.push(traspasoTradeDraft(leg.row, accountId, fxRates, fxRateWarnings));
    batches.forEach((b, i) => {
      if (demoted.has(i)) {
        for (const leg of b) drafts.push(traspasoTradeDraft(leg.row, accountId, fxRates, fxRateWarnings));
      } else {
        for (const p of plans[i]) drafts.push(...conversionDrafts(p, accountId, i));
      }
    });

    const all = [...otherDrafts, ...drafts];
    sortDrafts(all);
    const failures = unitShortfalls(all);
    if (failures.size > 0) {
      for (const [i, reason] of failures) demoted.set(i, reason);
      continue;
    }

    const legWarning = (leg: TraspasoLeg, reason: string): SkippedRow => ({
      date: leg.row.fechaOperacion,
      source: "fondos",
      type: leg.row.operacion,
      description: `${leg.row.nombre} (${leg.row.isin})`,
      reason: `Imported as ${leg.dir === "in" ? "BUY" : "SELL"} instead of a fund conversion: ${reason}`,
    });
    const warnings = [
      ...released.map((leg) =>
        legWarning(
          leg,
          leg.value == null
            ? `no ${leg.row.divisa}→EUR exchange rate to match it against its opposite switch leg`
            : `no opposite switch leg balances it within ${BATCH_WINDOW_DAYS} days (e.g. a traspaso from/to another bank, or an export that starts/ends mid-switch)`,
        ),
      ),
      ...batches.flatMap((b, i) => (demoted.has(i) ? b.map((leg) => legWarning(leg, demoted.get(i)!)) : [])),
    ].sort((a, b) => a.date.localeCompare(b.date));

    return {
      drafts,
      fxRateWarnings,
      warnings,
      batches: batches.flatMap((b, i) =>
        demoted.has(i)
          ? []
          : [
              {
                index: i,
                id: conversionRef(
                  b.filter((l) => l.dir === "out").map((l) => l.numOp),
                  b.filter((l) => l.dir === "in").map((l) => l.numOp),
                ),
                refs: plans[i].map((p) => p.ref),
                legNumOps: b.map((l) => l.numOp),
              },
            ],
      ),
    };
  }
}

export function transform(
  fondosRows: FondosRow[],
  movimientosRows: MovimientosRow[],
  config: AddonSettings,
  existingCashTransfersIn: ExistingCashTransferIn[] = [],
  existingDeposits: ExistingDeposit[] = [],
  fxRates: Record<string, number> = {},
): TransformResult {
  const { accountId } = config;
  const drafts: Draft[] = [];
  const skipped: SkippedRow[] = [];
  const duplicates: SkippedRow[] = [];
  const fxRateWarnings: SkippedRow[] = [];

  const cashPool = movimientosRows.map((row, index) => ({ row, index, consumed: false }));
  const traspasoRows: FondosRow[] = [];

  for (const r of fondosRows) {
    const titulos = fondosNum(r.titulos);
    const precio = fondosNum(r.precio);
    const instrumentType = "FUND";
    const orderHint = r.numOperacion.trim().padStart(12, "0");

    if (r.operacion === "SUSCRIPCION" || r.operacion === "REEMBOLSO") {
      const isBuy = r.operacion === "SUSCRIPCION";
      const expectedTipo = isBuy ? "SUSCRIPCION IIC" : "REEMBOLSO IIC";
      const match = findCashMatch(cashPool, expectedTipo, r.fechaLiquidacion, titulos, r.nombre, titulos * precio, r.divisa);

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
        // row (by share count or, failing that, fund name) — a real data
        // mismatch, surface it instead of guessing.
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

    // Fund switches (traspasos) are planned as a whole after this loop (see
    // planTraspasos): they become conversions where possible, BUY/SELL
    // otherwise.
    if (traspasoDirection(r.operacion)) {
      traspasoRows.push(r);
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

  const cashOccurrences = new Map<string, number>();
  for (const entry of cashPool) {
    if (entry.consumed) continue;
    const r = entry.row;
    const amt = movimientosNum(r.importe);
    const absAmt = Math.abs(amt);
    // Derived from the row's own content (see movimientosRowKey), never from
    // its position in the uploaded file(s). The first version used the
    // file index here, which was only "stable" as long as the exact same
    // set of files was uploaded in the exact same order: re-importing with a
    // different combination shifted every index, changed every cash
    // activity's [ref:...] description, and so defeated Wealthfolio's
    // description-based idempotency check, so every cash row got imported a
    // second time. The "z" prefix keeps cash rows sorting after same-day
    // fondos rows, as before.
    const rowKey = movimientosRowKey(r);
    const occurrence = (cashOccurrences.get(rowKey) ?? 0) + 1;
    cashOccurrences.set(rowKey, occurrence);
    const orderHint = `z${fnv1a(rowKey)}${occurrence > 1 ? `-${occurrence}` : ""}`;

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

    if (r.tipo === "COMISION CUSTODIA MYINVESTOR" || r.tipo === "COMISIONES CUSTODIA" || r.tipo === "COMISION GESTION CARTERA OF" || r.tipo === "IVA SOBRE COMISIONES") {
      drafts.push(cashAct(accountId, "FEE", r.fechaOperacion, orderHint, absAmt, r.tipo + (r.concepto ? ` - ${r.concepto}` : "")));
      continue;
    }

    if (r.tipo === "ABONO DE DIVIDENDO") {
      const { symbol, quantity } = conceptInstrument(r.concepto);
      if (amt >= 0) {
        if (quantity == null) {
          // No "<instrument> @ <shares>" in the concept means we have no
          // trustworthy symbol either — importing it would attach the
          // dividend to a made-up instrument. Surface it for manual review
          // instead, same as the BUY/SELL block below.
          skipped.push({
            date: r.fechaOperacion,
            source: "movimientos",
            type: r.tipo,
            description: r.concepto,
            reason: "Could not extract instrument name/quantity from concept text",
          });
          continue;
        }
        drafts.push({
          day: r.fechaOperacion,
          orderHint,
          activity: {
            accountId,
            activityType: "DIVIDEND",
            symbol,
            symbolName: symbol,
            instrumentType: "STOCK",
            quantity: fmtAmt(quantity),
            amount: fmtAmt(absAmt),
            currency: r.divisa,
            comment: r.concepto || r.tipo,
            isValid: true,
            isDraft: false,
          },
        });
      } else {
        // Some Inversis exports carry dividend correction/reversal entries
        // as negative "ABONO DE DIVIDENDO" rows (often prefixed with
        // "ANUL."). WITHDRAWAL would book the right cash outflow but
        // unconditionally inflates net_contribution (handle_withdrawal in
        // Wealthfolio's holdings calculator has no subtype escape, unlike
        // CREDIT) — wrongly counting a dividend clawback as money the user
        // personally pulled out. FEE is also a hardcoded cash outflow
        // (economic_events.rs's type_directed_cash_effect) but is
        // unconditionally excluded from net_contribution ("Charges do NOT
        // affect net_contribution", cash_flows.rs), matching how the
        // original DIVIDEND credit never touched it either. CREDIT (with a
        // REFUND/REBATE subtype) can't be used instead — it's hardcoded as
        // a cash inflow only, same bucket as DIVIDEND/INTEREST, so it can
        // never represent this outflow.
        drafts.push(
          cashAct(accountId, "FEE", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo, "REVERSAL"),
        );
      }
      continue;
    }

    if (
      r.tipo === "COMPRA RV CONTADO SF" ||
      r.tipo === "COMPRA RV CONTADO" ||
      r.tipo === "VENTA DE VALORES" ||
      r.tipo === "COMPRA RF VCTO" ||
      r.tipo === "AMORTIZACION RF"
    ) {
      const isBuy = r.tipo === "COMPRA RV CONTADO SF" || r.tipo === "COMPRA RV CONTADO" || r.tipo === "COMPRA RF VCTO";
      const instrumentType = r.tipo.includes("RF") ? "BOND" : "STOCK";
      const { symbol, quantity } = conceptInstrument(r.concepto);
      if (quantity == null || quantity === 0) {
        skipped.push({
          date: r.fechaOperacion,
          source: "movimientos",
          type: r.tipo,
          description: r.concepto,
          reason: "Could not extract quantity from concept text",
        });
        continue;
      }
      drafts.push({
        day: r.fechaOperacion,
        orderHint,
        activity: {
          accountId,
          activityType: isBuy ? "BUY" : "SELL",
          symbol,
          symbolName: symbol,
          instrumentType,
          quoteCcy: r.divisa,
          quantity: fmtAmt(quantity),
          unitPrice: fmtAmt(absAmt / quantity),
          fee: "0",
          currency: r.divisa,
          comment: `${r.tipo}${r.concepto ? ` - ${r.concepto}` : ""}`,
          isValid: true,
          isDraft: false,
        },
      });
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

    if (r.tipo === "TRANSFERENCIA SEPA" || r.tipo === "TRANSFERENCIA INMEDIATA" || r.tipo === "TRANSF INMEDIATA EMITIDA") {
      // A bank transfer in is often also recorded as a TRANSFER_IN by
      // whichever addon manages the source account (e.g.
      // trade-republic-importer-addon's Transfer Patterns) — importing it
      // again here as a DEPOSIT would double-count the same money as both
      // spending on that side and external income on this side. Deliberately
      // scoped to just SEPA/INMEDIATA, not TRANSF INMEDIATA EMITIDA (an
      // outgoing transfer, which shouldn't be matched against a TRANSFER_IN
      // even in the unusual case of a non-negative amount, e.g. a reversal).
      if (amt >= 0 && r.tipo !== "TRANSF INMEDIATA EMITIDA") {
        const transferIn = findAmountDateMatch(existingCashTransfersIn, r.fechaOperacion, absAmt);
        if (transferIn) {
          // The addons' import order isn't controlled by either one: if this
          // exact DEPOSIT was already created by an earlier import (before
          // this TRANSFER_IN existed to dedup against), there was nothing to
          // catch it at the time. We can't un-create that DEPOSIT, but since
          // every import re-scans the full movimientos history, we can at
          // least detect the now-confirmed duplicate and flag it for the
          // user to remove manually — closing the gap instead of silently
          // leaving a stale duplicate forever.
          const dupDeposit = findAmountDateMatch(existingDeposits, r.fechaOperacion, absAmt);
          duplicates.push({
            date: r.fechaOperacion,
            source: "movimientos",
            type: r.tipo,
            description: r.concepto,
            reason: dupDeposit
              ? `Matches an existing TRANSFER_IN${transferIn.id ? ` (id ${transferIn.id})` : ""} — and a DEPOSIT of the ` +
                `same amount/date already exists in this account too${dupDeposit.id ? ` (id ${dupDeposit.id})` : ""}, ` +
                "most likely created by an earlier import before that TRANSFER_IN existed to dedup against. " +
                "This looks like a real duplicate — delete the DEPOSIT activity manually in Wealthfolio."
              : "Matches an existing TRANSFER_IN of the same amount around this date in this account — " +
                "likely already recorded by another addon/import; not creating a duplicate DEPOSIT",
          });
          continue;
        }
      }
      drafts.push(
        cashAct(accountId, amt >= 0 ? "DEPOSIT" : "WITHDRAWAL", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo),
      );
      continue;
    }

    // Bizum (P2P) and card purchases are plain personal cash movements, same
    // as any other current-account transaction — just DEPOSIT/WITHDRAWAL.
    if (r.tipo === "BIZUM ENVIADO" || r.tipo === "COMPRA COMERCIO O/L") {
      drafts.push(cashAct(accountId, "WITHDRAWAL", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo));
      continue;
    }

    if (r.tipo === "BIZUM RECIBIDO") {
      drafts.push(cashAct(accountId, "DEPOSIT", r.fechaOperacion, orderHint, absAmt, r.concepto || r.tipo));
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

  const traspasos = planTraspasos(traspasoRows, drafts, accountId, fxRates);
  drafts.push(...traspasos.drafts);
  fxRateWarnings.push(...traspasos.fxRateWarnings);

  // Deterministic same-day ordering: sort by (day, orderHint).
  sortDrafts(drafts);

  // Wealthfolio's idempotency key hashes account+type+DATE-ONLY (time is
  // discarded)+asset+quantity+unitPrice+amount+fee+currency+description —
  // never a per-row id. MyInvestor's traspaso/switch batches routinely split
  // one transfer into several same-day fragments that land on the exact same
  // fund at the exact same NAV (identical quantity AND price), and duplicate
  // same-day/same-amount deposits happen too — those rows are byte-identical
  // on every hashed field, so without a distinguishing tag here they silently
  // collapse into one activity, dropping real shares/cash with no error
  // surfaced anywhere. `orderHint` is unique per source row (fondos
  // numOperacion, or a content hash for movimientos-only rows) and stable across
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

  const conversionBatches: ConversionBatchInfo[] = traspasos.batches.map(({ index, ...b }) => ({
    ...b,
    lineNumbers: drafts.flatMap((d, i) => (d.batch === index ? [i + 1] : [])),
  }));

  return {
    activities,
    skipped,
    duplicates,
    fxRateWarnings,
    conversionWarnings: traspasos.warnings,
    conversionBatches,
  };
}
