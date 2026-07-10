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

// "Movimientos" (cuenta corriente) export: 6 data columns per row.
function parseMovimientos(html: string): MovimientosRow[] {
  return tableRows(html, 6).map(([fOp, fVal, tipo, concepto, divisa, importe]) => ({
    fechaOperacion: ddmmyyyyToIso(fOp),
    fechaValor: ddmmyyyyToIso(fVal),
    tipo,
    concepto,
    divisa,
    importe,
  }));
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
