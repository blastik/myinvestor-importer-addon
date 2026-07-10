import type { ActivityImport, SymbolSearchResult } from "@wealthfolio/addon-sdk";

// One row from "Consulta de operaciones" (Inversiones > Fondos > Operaciones y
// consultas). Gives ISIN/quantity/price detail for every fund movement,
// including SUSCRIPCION/REEMBOLSO (regular buys/sells) AND the tax-free fund
// switches (SUSCR.POR TRASPASO I / REEMB.POR TRASPASO I / ALTA IIC SWITCH /
// BAJA IIC SWITCH), which never touch cash and only appear here.
export interface FondosRow {
  fechaOperacion: string; // YYYY-MM-DD
  fechaLiquidacion: string; // YYYY-MM-DD — joins to MovimientosRow.fechaValor
  numOperacion: string; // unique per row; used for stable same-day ordering
  mercado: string;
  operacion: string; // SUSCRIPCION | REEMBOLSO | SUSCR.POR TRASPASO I | REEMB.POR TRASPASO I | ALTA IIC SWITCH | BAJA IIC SWITCH
  isin: string;
  nombre: string;
  titulos: string; // quantity, in the fund's own (native) currency terms
  divisa: string; // fund's native currency (EUR or USD)
  precio: string; // unit price, native currency
  importe: string; // gross amount, native currency
}

// One row from "Movimientos" (Cuenta > Corriente > Operaciones y consultas).
// The single EUR cuenta corriente ledger: deposits, fees, interest, and the
// EUR cash side of every real buy/sell (SUSCRIPCION IIC / REEMBOLSO IIC).
export interface MovimientosRow {
  fechaOperacion: string; // YYYY-MM-DD
  fechaValor: string; // YYYY-MM-DD (settlement date)
  tipo: string;
  concepto: string;
  divisa: string; // always EUR in practice
  importe: string; // signed, EUR
}

export type SecurityMapping = SymbolSearchResult | "custom";

export interface AddonSettings {
  accountId: string;
  // ISIN -> resolved mapping, persisted so recurring imports of the same
  // fund don't require re-mapping every time.
  securityMappings: Record<string, SecurityMapping>;
}

export interface SkippedRow {
  date: string;
  source: "fondos" | "movimientos";
  type: string;
  description: string;
  reason: string;
}

// A pre-existing cash TRANSFER_IN already present in the target account,
// e.g. one created by another addon (like trade-republic-importer-addon's
// Transfer Patterns) when the user moves money from a different broker into
// this MyInvestor account. Used to avoid also recording that same money as a
// DEPOSIT from the movimientos "TRANSFERENCIA SEPA/INMEDIATA" row — neither
// addon can see the other's data, so this addon checks for the collision
// explicitly instead of relying on Wealthfolio's own duplicate detection
// (which never flags this: DEPOSIT and TRANSFER_IN are different
// activityTypes, so they hash to different idempotency keys).
export interface ExistingCashTransferIn {
  date: string; // YYYY-MM-DD
  amount: number;
}

export interface TransformResult {
  activities: ActivityImport[];
  skipped: SkippedRow[];
}
