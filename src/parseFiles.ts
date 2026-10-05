import type { FondosRow, MovimientosRow } from "./types";

// MyInvestor's "export to Excel" is actually an HTML table saved with a
// .xls extension, encoded as ISO-8859-1 (not UTF-8) — reading it via
// File.text() would mangle accented characters (á, ó, ñ...), so we always
// decode the raw bytes explicitly.
export async function readMyInvestorFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return new TextDecoder("iso-8859-1").decode(buffer);
}

function tableRows(html: string, cellCount: number): string[][] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows: string[][] = [];
  for (const tr of doc.querySelectorAll("tr")) {
    const cells = [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim());
    if (cells.length === cellCount) rows.push(cells);
  }
  return rows;
}

function ddmmyyyyToIso(s: string): string {
  const [d, m, y] = s.split("/");
  return `${y}-${m}-${d}`;
}

// "1.234,56" / "-2,48" -> -2.48 (Spanish decimal comma)
function esNumber(s: string): number {
  return parseFloat(s.replace(/\./g, "").replace(",", "."));
}

export type ParsedFile =
  | { kind: "fondos"; rows: FondosRow[] }
  | { kind: "movimientos"; rows: MovimientosRow[] }
  | { kind: "unknown" };

// "Consulta de operaciones" export: 11 data columns per row, header includes
// "ISIN" / "Títulos/NOMINAL" split across two <tr> header rows (rowspan).
function parseFondos(html: string): FondosRow[] {
  return tableRows(html, 11).map(
    ([fOp, fLiq, numOp, mercado, operacion, isin, nombre, titulos, divisa, precio, importe]) => ({
      fechaOperacion: fOp,
      fechaLiquidacion: fLiq,
      numOperacion: numOp,
      mercado,
      operacion,
      isin,
      nombre,
      titulos,
      divisa,
      precio,
      importe,
    }),
  );
}

// "Movimientos" (cuenta corriente) export: two different Inversis screens
// produce the same logical data with different column layouts.
// "Operaciones y consultas > Movimientos" ("Operaciones de cuentas" title):
// 6 columns — Fecha operación, Fecha valor, Tipo, Concepto, explicit Divisa,
// signed Importe.
// "Cuenta > Corriente > Movimientos" ("Movimientos de cuentas" title): 7
// columns — no Divisa column (cash is always EUR, see MovimientosRow.divisa),
// a Cargo/Abono C/A indicator column that's redundant with Importe's own
// sign (ignored), and a trailing running Saldo balance column (kept only as
// a row-identity tiebreaker, see movimientosRowKey).
function parseMovimientos(html: string): MovimientosRow[] {
  const sixColumn = tableRows(html, 6).map(([fOp, fVal, tipo, concepto, divisa, importe]) => ({
    fechaOperacion: ddmmyyyyToIso(fOp),
    fechaValor: ddmmyyyyToIso(fVal),
    tipo,
    concepto,
    divisa,
    importe,
  }));
  if (sixColumn.length > 0) return sixColumn;

  return tableRows(html, 7).map(([fOp, fVal, tipo, concepto, , importe, saldo]) => ({
    fechaOperacion: ddmmyyyyToIso(fOp),
    fechaValor: ddmmyyyyToIso(fVal),
    tipo,
    concepto,
    divisa: "EUR",
    importe,
    saldo,
  }));
}

// Content-based identity for a movimientos row, independent of which file
// it came from or its position in that file. Used both to build the
// row's [ref:...] tag (see transform.ts) and to collapse rows that appear in
// more than one uploaded export (overlapping date ranges).
export function movimientosRowKey(r: MovimientosRow): string {
  const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ");
  return [r.fechaOperacion, r.fechaValor, norm(r.tipo), norm(r.concepto), norm(r.importe), norm(r.saldo)].join("|");
}

// Combines several movimientos exports into one row list without
// double-counting rows that more than one of them contains (e.g. a
// "last 12 months" export uploaded next to a lifetime one). A row that
// legitimately appears N times within a single export (two identical
// same-day transfers in the 6-column layout, which has no Saldo to tell
// them apart) is kept N times — the merged count for each key is the
// maximum seen in any one file, not the sum across files.
export function mergeMovimientosFiles(files: MovimientosRow[][]): MovimientosRow[] {
  const kept = new Map<string, number>();
  const merged: MovimientosRow[] = [];
  for (const rows of files) {
    const seenInFile = new Map<string, number>();
    for (const r of rows) {
      const key = movimientosRowKey(r);
      const n = (seenInFile.get(key) ?? 0) + 1;
      seenInFile.set(key, n);
      if (n > (kept.get(key) ?? 0)) {
        kept.set(key, n);
        merged.push(r);
      }
    }
  }
  return merged;
}

export function parseMyInvestorHtml(html: string): ParsedFile {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const headerText = [...doc.querySelectorAll("th")]
    .map((th) => (th.textContent ?? "").trim())
    .join(" ");

  if (headerText.includes("ISIN")) {
    const rows = parseFondos(html);
    return rows.length > 0 ? { kind: "fondos", rows } : { kind: "unknown" };
  }
  if (headerText.includes("Tipo de operaci")) {
    const rows = parseMovimientos(html);
    return rows.length > 0 ? { kind: "movimientos", rows } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

export function fondosNum(s: string): number {
  return parseFloat(s);
}

export const movimientosNum = esNumber;

// A short, structural-only summary of a file that didn't match any known
// export shape — meant to be pasted into a bug report. Deliberately limited
// to the <title> tag and header (<th>) text plus a histogram of <td>-count
// per <tr>: this is enough to diagnose a new Inversis screen/column layout
// (see parseMovimientos' two known variants) without including any actual
// cell content, which is the user's real dates/amounts/fund names.
export function describeUnknownFormat(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = doc.querySelector("title")?.textContent?.trim() || "(no <title> found)";
  const headers = [...doc.querySelectorAll("th")]
    .map((th) => (th.textContent ?? "").trim())
    .filter(Boolean);

  const rowShapeCounts = new Map<number, number>();
  for (const tr of doc.querySelectorAll("tr")) {
    const cellCount = tr.querySelectorAll("td").length;
    if (cellCount > 0) rowShapeCounts.set(cellCount, (rowShapeCounts.get(cellCount) ?? 0) + 1);
  }
  const rowShapes =
    [...rowShapeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cols, count]) => `${count} row(s) with ${cols} <td> cells`)
      .join(", ") || "no <tr> with <td> cells found";

  return [
    `Title: ${title}`,
    `Headers: ${headers.length > 0 ? headers.join(" | ") : "(none found)"}`,
    `Row shapes: ${rowShapes}`,
  ].join("\n");
}
