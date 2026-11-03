import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { conversionRefLegs, normalizeNumOp } from "./conversions";
import type { ConversionBatchInfo } from "./types";

// An activity already stored in the target account, as read back via
// ctx.api.activities.getAll() — only the fields needed to recognise it again.
export interface ExistingActivity {
  id: string;
  activityType: string;
  subtype?: string | null;
  date: string; // YYYY-MM-DD
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  fxRate: number | null;
  comment: string;
}

export interface ExistingMatch {
  existingId: string;
  // True when the matched activity's economic fields (quantity, price,
  // amount, fxRate) differ from what this import would create — e.g. an
  // earlier addon version booked it with a different exchange rate.
  // Including the row updates the existing activity to the new values.
  differs: boolean;
  // The import would book this switch leg as a BUY/SELL, but an earlier
  // import already made it part of a fund conversion (existingId is one of
  // that conversion's rows). Updating the conversion row into a trade would
  // break the pair, and creating the trade would count the units twice, so
  // such a row can only be skipped.
  alreadyConverted?: boolean;
}

const REF_TAG = /\s*\[ref:([^\]]+)\]\s*$/;

function refOf(comment: string | undefined): string | undefined {
  return comment?.match(REF_TAG)?.[1];
}

function stripRef(comment: string | undefined): string {
  return (comment ?? "").replace(REF_TAG, "").trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function close(a: number | null, b: number | null, tol: number): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= tol;
}

export function isConversionRow(a: { activityType: string; subtype?: string | null }): boolean {
  return a.activityType === "ADJUSTMENT" && (a.subtype === "CONVERSION_OUT" || a.subtype === "CONVERSION_IN");
}

// numOperacion (unpadded) → existing conversion rows built from that leg.
function existingConversionsByLeg(existing: ExistingActivity[]): Map<string, ExistingActivity[]> {
  const byLeg = new Map<string, ExistingActivity[]>();
  for (const e of existing) {
    if (!isConversionRow(e)) continue;
    for (const numOp of conversionRefLegs(refOf(e.comment) ?? "") ?? []) {
      byLeg.set(numOp, [...(byLeg.get(numOp) ?? []), e]);
    }
  }
  return byLeg;
}

function isTrade(type: string): boolean {
  return type === "BUY" || type === "SELL";
}

// The value that identifies "the same money movement": share count for a
// trade, cash amount for everything else.
function identityValue(type: string, quantity: number | null, amount: number | null): number | null {
  return isTrade(type) ? quantity : amount != null ? Math.abs(amount) : null;
}

// Fondos-derived activities carry the broker's own operation number as their
// ref (all digits); movimientos-derived ones carry a "z"-prefixed tag whose
// format has changed across addon versions, so it's not a usable identity.
function isFondosRef(ref: string | undefined): ref is string {
  return ref != null && /^\d+$/.test(ref);
}

// Finds which of this import's activities already exist in the account,
// independently of Wealthfolio's own checkImport. That check hashes the full
// description and every price field, so it misses an activity this addon
// already created whenever anything incidental changed between imports —
// the [ref:...] tag format (movimientos refs used to be file positions, see
// transform.ts), or a derived unitPrice/fxRate (a different movimientos file
// set, a corrected exchange-rate lookup). Matching here is on what
// identifies the real-world transaction instead:
//   1. Fund trades: the fondos operation number in the [ref:...] tag, which
//      is the broker's own id and has never changed format.
//   2. Everything else: activity type + day + description (minus the ref
//      tag) + amount, or share count for trades.
// Each existing activity matches at most one imported one, so two genuine
// identical same-day rows still need two existing activities to both be
// flagged.
export function findExistingMatches(
  activities: ActivityImport[],
  existing: ExistingActivity[],
): Map<number, ExistingMatch> {
  const matches = new Map<number, ExistingMatch>();
  const used = new Set<string>();

  const byFondosRef = new Map<string, ExistingActivity[]>();
  const byKey = new Map<string, ExistingActivity[]>();
  const conversionsByLeg = existingConversionsByLeg(existing);
  for (const e of existing) {
    // Conversion rows are matched per batch by planConversionBatches.
    if (isConversionRow(e)) continue;
    const ref = refOf(e.comment);
    if (isFondosRef(ref)) {
      byFondosRef.set(ref, [...(byFondosRef.get(ref) ?? []), e]);
    }
    const key = `${e.activityType}|${e.date}|${stripRef(e.comment)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }

  const record = (a: ActivityImport, e: ExistingActivity) => {
    used.add(e.id);
    const differs =
      !close(num(a.quantity), e.quantity, 1e-9) ||
      !close(num(a.unitPrice), e.unitPrice, 1e-9) ||
      (!isTrade(a.activityType) && !close(num(a.amount), e.amount, 0.005)) ||
      !close(num(a.fxRate), e.fxRate, 1e-12);
    matches.set(a.lineNumber as number, { existingId: e.id, differs });
  };

  for (const a of activities) {
    if (a.lineNumber == null || isConversionRow(a)) continue;
    const ref = refOf(a.comment);
    if (!isFondosRef(ref)) continue;
    const e = byFondosRef.get(ref)?.find((c) => !used.has(c.id) && c.activityType === a.activityType);
    if (e) {
      record(a, e);
      continue;
    }
    const converted = conversionsByLeg.get(normalizeNumOp(ref))?.[0];
    if (converted) matches.set(a.lineNumber, { existingId: converted.id, differs: false, alreadyConverted: true });
  }

  for (const a of activities) {
    if (a.lineNumber == null || matches.has(a.lineNumber) || isConversionRow(a)) continue;
    const day = String(a.date).slice(0, 10);
    const key = `${a.activityType}|${day}|${stripRef(a.comment)}`;
    const value = identityValue(a.activityType, num(a.quantity), num(a.amount));
    const e = byKey
      .get(key)
      ?.find(
        (c) =>
          !used.has(c.id) &&
          close(identityValue(c.activityType, c.quantity, c.amount), value, isTrade(a.activityType) ? 1e-6 : 0.005),
      );
    if (e) record(a, e);
  }

  return matches;
}

export interface ConversionBatchPlan {
  batchId: string;
  // Conversion rows to create (both rows of every conversion that doesn't
  // already exist exactly as planned).
  createLines: number[];
  // Conversion rows that already exist exactly (same ref, direction and
  // units) → the existing activity id. Re-imports skip these.
  existingLines: Map<number, string>;
  // Existing activities this batch replaces: the BUY/SELL an earlier
  // version of this addon booked for the batch's switch legs, and
  // conversions an earlier allocation built from any of its legs (both rows
  // of each). Deleted in the same saveMany that creates `createLines`.
  deleteIds: string[];
  replacedTrades: number; // how many of deleteIds are BUY/SELL
}

// Decides, per switch batch, what writing it means against what the account
// already has. Wealthfolio's own duplicate check can't do this: the old
// BUY/SELL legs are different activity types than the conversion that
// supersedes them, so without deleting them every switch would be counted
// twice. The batch is the unit (not the single conversion pair): its legs
// are spread across several conversions, so its old activities can only be
// replaced all at once.
export function planConversionBatches(
  batches: ConversionBatchInfo[],
  activities: ActivityImport[],
  existing: ExistingActivity[],
): ConversionBatchPlan[] {
  const conversionsByRef = new Map<string, ExistingActivity[]>();
  const tradesByLeg = new Map<string, ExistingActivity[]>();
  for (const e of existing) {
    const ref = refOf(e.comment);
    if (isConversionRow(e) && ref) {
      conversionsByRef.set(ref, [...(conversionsByRef.get(ref) ?? []), e]);
    } else if (isTrade(e.activityType) && isFondosRef(ref)) {
      const numOp = normalizeNumOp(ref);
      tradesByLeg.set(numOp, [...(tradesByLeg.get(numOp) ?? []), e]);
    }
  }
  const conversionsByLeg = existingConversionsByLeg(existing);
  const byLine = new Map(activities.filter((a) => a.lineNumber != null).map((a) => [a.lineNumber as number, a]));

  return batches.map((batch) => {
    const rows = batch.lineNumbers.map((ln) => byLine.get(ln)).filter((a): a is ActivityImport => a != null);
    const rowsByRef = new Map<string, ActivityImport[]>();
    for (const a of rows) {
      const ref = refOf(a.comment) ?? "";
      rowsByRef.set(ref, [...(rowsByRef.get(ref) ?? []), a]);
    }

    const existingLines = new Map<number, string>();
    const kept = new Set<string>(); // existing ids left untouched
    const createLines: number[] = [];
    for (const [ref, refRows] of rowsByRef) {
      const candidates = conversionsByRef.get(ref) ?? [];
      const exact = refRows.map((a) =>
        candidates.find((e) => e.subtype === a.subtype && close(e.quantity, num(a.quantity), 1e-9)),
      );
      if (candidates.length === refRows.length && exact.every((e) => e != null)) {
        refRows.forEach((a, i) => {
          existingLines.set(a.lineNumber as number, exact[i]!.id);
          kept.add(exact[i]!.id);
        });
      } else {
        createLines.push(...refRows.map((a) => a.lineNumber as number));
      }
    }

    const deleteIds = new Set<string>();
    let replacedTrades = 0;
    for (const numOp of batch.legNumOps) {
      for (const e of tradesByLeg.get(numOp) ?? []) {
        if (!deleteIds.has(e.id)) replacedTrades += 1;
        deleteIds.add(e.id);
      }
      for (const e of conversionsByLeg.get(numOp) ?? []) {
        if (kept.has(e.id)) continue;
        // Both rows of that conversion, so no half-pair is left behind.
        for (const row of conversionsByRef.get(refOf(e.comment) ?? "") ?? [e]) deleteIds.add(row.id);
      }
    }

    return {
      batchId: batch.id,
      createLines: createLines.sort((a, b) => a - b),
      existingLines,
      deleteIds: [...deleteIds].sort(),
      replacedTrades,
    };
  });
}
