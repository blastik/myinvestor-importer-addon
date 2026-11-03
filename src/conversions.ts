import type { FondosRow } from "./types";
import { fondosNum } from "./parseFiles";

// Fund switches (traspasos) as Wealthfolio conversions: two ADJUSTMENT rows,
// CONVERSION_OUT and CONVERSION_IN, sharing a sourceGroupId (Wealthfolio
// 3.12+, wealthfolio#2336). The engine pairs them only when the group is
// exactly one OUT row and one IN row, on one business day, in one currency,
// between two different assets. MyInvestor's legs don't look like that: one
// switch is spread over several days (BAJA first, ALTA fragments up to a
// week later) and is many-to-many (e.g. 11 ALTA fragments into one fund,
// funded by BAJA legs from two different funds), with no shared reference
// between legs. This module does the matching the export doesn't:
//
//   1. batchLegs(): groups legs into switch batches whose out-value and
//      in-value balance, walking them in date order.
//   2. allocateBatch(): splits each batch into 1:1 conversions, one per
//      (leaving fund, arriving fund, arrival day), proportionally by value,
//      in exact fixed-point arithmetic.
//
// Changing either rule changes the conversion refs (and so the
// sourceGroupIds) of already-imported switches. dedup.ts then replaces the
// old conversions with the new ones, but treat it as a breaking change.

export type LegDirection = "out" | "in";

export interface TraspasoLeg {
  row: FondosRow;
  dir: LegDirection;
  numOp: string; // numOperacion without padding/leading zeros
  // Leg value in EUR (fondos importe, converted at the settlement-date rate
  // for non-EUR funds). Undefined when no rate is available.
  value: number | undefined;
}

export function traspasoDirection(operacion: string): LegDirection | undefined {
  if (operacion === "REEMB.POR TRASPASO I" || operacion === "BAJA IIC SWITCH") return "out";
  if (operacion === "SUSCR.POR TRASPASO I" || operacion === "ALTA IIC SWITCH") return "in";
  return undefined;
}

export function normalizeNumOp(numOperacion: string): string {
  return numOperacion.trim().replace(/^0+(?=\d)/, "");
}

// A batch has not finished switching when this many days have passed since
// its first leg; real legs settle 1–7 days apart.
export const BATCH_WINDOW_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);
}

// Out-value and in-value of a switch batch are what the broker moved, so
// for EUR funds they agree to the cent; the tolerance only absorbs rounding.
// A batch with a non-EUR leg is valued through an external historical rate,
// which is approximate, so it gets more room (such a batch is never
// converted, see batchCurrencyIssue, but it still has to close so its legs
// don't get paired with unrelated ones).
function balanceTolerance(outSum: number, hasForeign: boolean): number {
  return Math.max(0.1, outSum * (hasForeign ? 0.02 : 0.005));
}

export function sortLegs(legs: TraspasoLeg[]): TraspasoLeg[] {
  return [...legs].sort((a, b) => {
    if (a.row.fechaOperacion !== b.row.fechaOperacion) return a.row.fechaOperacion.localeCompare(b.row.fechaOperacion);
    if (a.dir !== b.dir) return a.dir === "out" ? -1 : 1;
    return a.numOp.padStart(20, "0").localeCompare(b.numOp.padStart(20, "0"));
  });
}

// Walks the legs in date order (outs before ins on the same day) keeping a
// running balance of out-value minus in-value, and closes a batch at the
// first point where both sides are present and the balance is back to ~0.
// When no closing point is found within BATCH_WINDOW_DAYS of the batch's
// first leg, that first leg alone is released as unpaired and the walk
// restarts from the next leg — so one stray leg (an incoming traspaso from
// another bank, an export cut partway through a switch) only affects itself
// instead of every switch after it.
export function batchLegs(legs: TraspasoLeg[]): { batches: TraspasoLeg[][]; released: TraspasoLeg[] } {
  const sorted = sortLegs(legs);
  const batches: TraspasoLeg[][] = [];
  const released: TraspasoLeg[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let balance = 0;
    let outSum = 0;
    let hasOut = false;
    let hasIn = false;
    let hasForeign = false;
    let end = -1;
    for (let j = i; j < sorted.length; j++) {
      const leg = sorted[j];
      if (daysBetween(start.row.fechaOperacion, leg.row.fechaOperacion) > BATCH_WINDOW_DAYS) break;
      const v = leg.value ?? NaN; // an unvalued leg keeps the batch from closing
      if (leg.row.divisa !== "EUR") hasForeign = true;
      if (leg.dir === "out") {
        hasOut = true;
        outSum += v;
        balance += v;
      } else {
        hasIn = true;
        balance -= v;
      }
      // Only close at the end of a day. A batch that is within tolerance
      // partway through a day would otherwise strand that day's remaining
      // small fragments as unpaired legs (seen on a real 80-leg switch: a
      // €6.31 fragment left out of a €3,388.89 batch whose 0.5% tolerance
      // was reached one fragment early).
      const endOfDay = j + 1 === sorted.length || sorted[j + 1].row.fechaOperacion !== leg.row.fechaOperacion;
      if (endOfDay && hasOut && hasIn && Math.abs(balance) <= balanceTolerance(outSum, hasForeign)) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      released.push(start);
      i += 1;
    } else {
      batches.push(sorted.slice(i, end + 1));
      i = end + 1;
    }
  }
  return { batches, released };
}

// Why a batch can't be a conversion even though its legs balance: Wealthfolio
// conversions keep one currency (cross-currency is "not yet supported" in
// wealthfolio#2336), so a switch between a EUR and a USD fund stays BUY/SELL.
export function batchCurrencyIssue(batch: TraspasoLeg[]): string | undefined {
  const currencies = new Set(batch.map((l) => l.row.divisa));
  if (currencies.size > 1) {
    return `switch between funds in different currencies (${[...currencies].sort().join("/")}); Wealthfolio conversions need one currency`;
  }
  return undefined;
}

// ── Exact fixed-point units ──────────────────────────────────────────────────

const SCALE_DIGITS = 10;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export function toUnits(s: string): bigint {
  const t = s.trim();
  const neg = t.startsWith("-");
  const [int, frac = ""] = t.replace(/^[-+]/, "").split(".");
  const fracPadded = (frac + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  const v = BigInt(int || "0") * SCALE + BigInt(fracPadded || "0");
  return neg ? -v : v;
}

export function formatUnits(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

// Values as integer hundredths of a cent, so value shares are exact ratios.
function valueWeight(v: number): bigint {
  return BigInt(Math.round(v * 10000));
}

// Splits `total` into pieces proportional to `weights`, flooring every piece
// but the last, which takes the exact remainder: the pieces always sum to
// exactly `total`. That matters for the leaving side — the engine rejects a
// conversion whose leaving units exceed what the account holds, even by
// 1e-10 — and it keeps the arriving side's share count exact too.
function splitProportional(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  const pieces: bigint[] = [];
  let given = 0n;
  weights.forEach((w, idx) => {
    const piece = idx === weights.length - 1 ? total - given : (total * w) / sum;
    pieces.push(piece);
    given += piece;
  });
  return pieces;
}

export interface PlannedConversion {
  // Deterministic id from the legs involved: `c<out numOps>><in numOps>`.
  // Doubles as the activities' [ref:...] tag and (prefixed) sourceGroupId.
  ref: string;
  day: string; // arrival (IN legs') fechaOperacion; both rows are dated here
  outRow: FondosRow; // representative leg, for isin/nombre/divisa
  inRow: FondosRow;
  outUnits: string;
  inUnits: string;
  outLegs: string[]; // numOps
  inLegs: string[];
}

export const CONVERSION_GROUP_PREFIX = "myinvestor:";

export function conversionRef(outLegs: string[], inLegs: string[]): string {
  const sortNums = (xs: string[]) => [...xs].sort((a, b) => a.padStart(20, "0").localeCompare(b.padStart(20, "0")));
  return `c${sortNums(outLegs).join("+")}>${sortNums(inLegs).join("+")}`;
}

// Inverse of conversionRef: the numOps of every leg a conversion was built
// from, or undefined when `ref` isn't a conversion ref.
export function conversionRefLegs(ref: string): string[] | undefined {
  const m = ref.match(/^c([\d+]+)>([\d+]+)$/);
  if (!m) return undefined;
  return [...m[1].split("+"), ...m[2].split("+")];
}

// Splits one balanced, single-currency batch into 1:1 conversions, one per
// (leaving fund A, arriving fund B, arrival day d). Nothing in the export
// says which leaving fund paid for which arriving fragment, so every A funds
// every (B, d) in proportion to value:
//   - A's leaving units are split across the (B, d) sets by each set's share
//     of the batch's in-value;
//   - each (B, d) set's arriving units are split across the A's by each A's
//     share of the batch's out-value.
// Every leg's units are used exactly once on its own side (see
// splitProportional). Returns a reason string instead when the batch can't
// be expressed this way.
export function allocateBatch(batch: TraspasoLeg[]): PlannedConversion[] | string {
  const outs = new Map<string, TraspasoLeg[]>();
  const ins = new Map<string, TraspasoLeg[]>();
  for (const leg of batch) {
    if (leg.dir === "out") {
      outs.set(leg.row.isin, [...(outs.get(leg.row.isin) ?? []), leg]);
    } else {
      const key = `${leg.row.fechaOperacion}|${leg.row.isin}`;
      ins.set(key, [...(ins.get(key) ?? []), leg]);
    }
  }
  const outKeys = [...outs.keys()].sort();
  const inKeys = [...ins.keys()].sort();
  const sumValue = (legs: TraspasoLeg[]) => valueWeight(legs.reduce((s, l) => s + (l.value ?? 0), 0));
  const sumUnits = (legs: TraspasoLeg[]) => legs.reduce((s, l) => s + toUnits(l.row.titulos), 0n);

  const outWeights = outKeys.map((k) => sumValue(outs.get(k)!));
  const inWeights = inKeys.map((k) => sumValue(ins.get(k)!));
  if (outWeights.some((w) => w <= 0n) || inWeights.some((w) => w <= 0n)) {
    return "a switch leg has no value to allocate by";
  }

  // outPieces[a][b] = units of out fund a leaving towards in set b
  const outPieces = outKeys.map((k) => splitProportional(sumUnits(outs.get(k)!), inWeights));
  // inPieces[b][a] = units of in set b arriving from out fund a
  const inPieces = inKeys.map((k) => splitProportional(sumUnits(ins.get(k)!), outWeights));

  if (inKeys.some((k) => outs.has(k.split("|")[1]))) return "a fund is switched into itself";

  const planned: PlannedConversion[] = [];
  outKeys.forEach((outIsin, a) => {
    inKeys.forEach((inKey, b) => {
      const outLegs = outs.get(outIsin)!;
      const inLegs = ins.get(inKey)!;
      const outRow = outLegs[0].row;
      const inRow = inLegs[0].row;
      planned.push({
        ref: conversionRef(
          outLegs.map((l) => l.numOp),
          inLegs.map((l) => l.numOp),
        ),
        day: inRow.fechaOperacion,
        outRow,
        inRow,
        outUnits: formatUnits(outPieces[a][b]),
        inUnits: formatUnits(inPieces[b][a]),
        outLegs: outLegs.map((l) => l.numOp),
        inLegs: inLegs.map((l) => l.numOp),
      });
    });
  });

  if (planned.some((p) => toUnits(p.outUnits) <= 0n || toUnits(p.inUnits) <= 0n)) {
    return "splitting the switch across funds leaves a piece with no units";
  }
  return planned;
}

export function legValue(r: FondosRow, eurRate: number | undefined): number | undefined {
  const importe = fondosNum(r.importe);
  const native = importe > 0 ? importe : fondosNum(r.titulos) * fondosNum(r.precio);
  if (!(native > 0)) return undefined;
  if (r.divisa === "EUR") return native;
  return eurRate != null && Number.isFinite(eurRate) && eurRate > 0 ? native * eurRate : undefined;
}
