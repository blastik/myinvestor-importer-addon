import type { ActivityImport } from "@wealthfolio/addon-sdk";

// An activity already stored in the target account, as read back via
// ctx.api.activities.getAll() — only the fields needed to recognise it again.
export interface ExistingActivity {
  id: string;
  activityType: string;
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
  for (const e of existing) {
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
    if (a.lineNumber == null) continue;
    const ref = refOf(a.comment);
    if (!isFondosRef(ref)) continue;
    const e = byFondosRef.get(ref)?.find((c) => !used.has(c.id) && c.activityType === a.activityType);
    if (e) record(a, e);
  }

  for (const a of activities) {
    if (a.lineNumber == null || matches.has(a.lineNumber)) continue;
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
