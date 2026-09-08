import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  Account,
  ActivityCreate,
  ActivityImport,
  ActivityUpdate,
  AddonContext,
  ExchangeRateDateQuery,
  ImportActivitiesResult,
} from "@wealthfolio/addon-sdk";
import {
  Button,
  Card,
  CardContent,
  Icons,
  Progress,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import { loadSettings, saveSettings } from "./settings";
import { describeUnknownFormat, parseMyInvestorHtml, readMyInvestorFile } from "./parseFiles";
import { SecurityMappingStep } from "./SecurityMappingStep";
import type { SecurityInfo, SecurityMapping } from "./SecurityMappingStep";
import { fxRateKey, isForeignTraspaso, transform } from "./transform";
import type {
  AddonSettings,
  ExistingCashTransferIn,
  ExistingDeposit,
  FondosRow,
  MovimientosRow,
  SkippedRow,
  TransformResult,
} from "./types";

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return String(iso).replace("T", " ").slice(0, 16);
}

function truncate(s: string | null | undefined, n = 60): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Prefills a GitHub issue with a structural-only diagnostic (see
// describeUnknownFormat) so a report on a new/changed export layout arrives
// with enough detail to fix without back-and-forth — and without asking the
// user to paste their actual financial data anywhere.
function newFormatIssueUrl(fileName: string, diagnostic: string): string {
  const title = `Unrecognised export format: ${fileName}`;
  const body = [
    "MyInvestor Importer didn't recognise this file as a valid \"movimientos\" or \"fondos\" export.",
    "",
    "**Diagnostic summary** (structural only — no dates, amounts, or fund names):",
    "```",
    diagnostic,
    "```",
    "",
    "If you're able to, please also attach the export file here with any amounts, names, and account numbers redacted.",
  ].join("\n");
  const params = new URLSearchParams({ title, body });
  return `https://github.com/blastik/myinvestor-importer-addon/issues/new?${params.toString()}`;
}

function activityStatus(a: ActivityImport): "valid" | "duplicate" | "error" {
  if (a.duplicateOfId) return "duplicate";
  if (!a.isValid || (a.errors && Object.keys(a.errors).length > 0)) return "error";
  return "valid";
}

function firstError(a: ActivityImport): string {
  if (!a.errors) return "";
  const msgs = Object.values(a.errors).flat();
  return msgs[0] ?? "";
}

function displayAmount(a: ActivityImport): string {
  const ccy = a.currency ?? "EUR";
  if (a.amount != null && a.amount !== "") return `${Number(a.amount).toFixed(2)} ${ccy}`;
  if (a.quantity != null && a.unitPrice != null) {
    return `${(parseFloat(String(a.quantity)) * parseFloat(String(a.unitPrice))).toFixed(2)} ${ccy}`;
  }
  return "—";
}

function applySecurityMappings(
  activities: ActivityImport[],
  resolvedMappings: Map<string, SecurityMapping>,
): ActivityImport[] {
  return activities.map((a) => {
    if (!a.symbol || a.symbol === "$CASH-EUR") return a;
    const m = resolvedMappings.get(a.symbol);
    if (!m || m === "custom") return a;
    return {
      ...a,
      symbol: m.canonicalSymbol || m.symbol,
      symbolName: m.shortName,
      exchangeMic: m.canonicalExchangeMic || m.exchangeMic,
      quoteCcy: m.currency || a.quoteCcy,
      instrumentType: m.quoteType === "ETF" ? "FUND" : a.instrumentType,
      providerId: m.providerId,
      providerSymbol: m.providerSymbol,
      assetId: m.existingAssetId,
    };
  });
}

// ─── ExportUploadZone ───────────────────────────────────────────────────────

interface FileSlot {
  fileName: string;
  rows: FondosRow[] | MovimientosRow[];
}

const EXPORT_INFO: Record<"movimientos" | "fondos", { title: string; menuPath: string }> = {
  movimientos: {
    title: "Cuentas",
    menuPath: "Cuenta > Corriente > Operaciones y consultas > Consulta de operaciones",
  },
  fondos: {
    title: "Inversiones",
    menuPath: "Inversiones > Fondos > Operaciones y consultas > Consulta de operaciones",
  },
};

function ExportUploadZone({
  kind,
  slots,
  onFiles,
  onRemove,
}: {
  kind: "movimientos" | "fondos";
  slots: FileSlot[];
  onFiles: (files: File[], kind: "movimientos" | "fondos") => void;
  onRemove: (kind: "movimientos" | "fondos", fileName: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const info = EXPORT_INFO[kind];

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const list = [...files];
      if (list.length > 0) onFiles(list, kind);
    },
    [onFiles, kind],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
        dragging
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/30 hover:border-primary/50"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xls,.html"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files ?? []);
          e.target.value = "";
        }}
      />
      <p className="text-sm font-medium">{info.title}</p>
      <p className="text-muted-foreground mt-1 text-xs">{info.menuPath}</p>
      <div className="mt-4">
        {slots.length > 0 ? (
          <div className="space-y-1.5">
            {slots.map((slot) => (
              <div key={slot.fileName} className="flex items-center justify-center gap-2">
                <Icons.FileText className="text-muted-foreground h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium">{slot.fileName}</p>
                  <p className="text-muted-foreground text-xs">{slot.rows.length} rows parsed</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(kind, slot.fileName);
                  }}
                  className="text-muted-foreground hover:text-destructive shrink-0 px-1 text-xs"
                  aria-label={`Remove ${slot.fileName}`}
                >
                  ✕
                </button>
              </div>
            ))}
            <p className="text-muted-foreground pt-1 text-xs">Click or drop to add more files</p>
          </div>
        ) : (
          <>
            <Icons.Upload className="text-muted-foreground mx-auto h-6 w-6" />
            <p className="text-muted-foreground mt-1 text-xs">Drop file(s) here, or click to browse</p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── SkippedTable ────────────────────────────────────────────────────────────

function SkippedTable({ rows }: { rows: SkippedRow[] }) {
  if (rows.length === 0)
    return <p className="text-muted-foreground p-3 text-xs">No rows were skipped.</p>;
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-xs">
        <thead className="bg-background sticky top-0 border-b">
          <tr>
            {["Date", "Source", "Type", "Description", "Reason"].map((h) => (
              <th key={h} className="text-muted-foreground px-2 py-1.5 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-border/50 border-b">
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.date}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.source}</td>
              <td className="whitespace-nowrap px-2 py-1 font-mono">{r.type}</td>
              <td className="text-muted-foreground px-2 py-1">{truncate(r.description, 80)}</td>
              <td className="text-muted-foreground px-2 py-1">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── ActivityRow ─────────────────────────────────────────────────────────────

function ActivityRow({
  activity,
  accountName,
  included,
  onToggleInclude,
}: {
  activity: ActivityImport;
  accountName: (id: string) => string;
  included: boolean;
  onToggleInclude: () => void;
}) {
  const status = activityStatus(activity);
  return (
    <tr className="border-border/50 hover:bg-muted/30 border-b">
      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">
        {fmtDate(String(activity.date))}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-xs">{accountName(activity.accountId)}</td>
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
          {activity.activityType}
        </span>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">{activity.symbol ?? "—"}</td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs">
        {displayAmount(activity)}
      </td>
      <td className="px-2 py-1.5 text-xs">
        {status === "valid" && <span className="text-muted-foreground text-[10px]">Ready</span>}
        {status === "duplicate" && (
          <div className="flex items-center gap-1.5">
            <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
              Duplicate
            </span>
            <button
              onClick={onToggleInclude}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                included
                  ? "text-muted-foreground hover:text-foreground"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              {included ? "Skip" : "Include"}
            </button>
          </div>
        )}
        {status === "error" && (
          <span className="text-destructive text-[10px]" title={firstError(activity)}>
            {truncate(firstError(activity), 50)}
          </span>
        )}
      </td>
    </tr>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

type Step = "upload" | "asset-review" | "checking" | "confirm" | "importing" | "done";

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const [step, setStep] = useState<Step>("upload");
  const [settings, setSettings] = useState<AddonSettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [fondosFiles, setFondosFiles] = useState<FileSlot[]>([]);
  const [movimientosFiles, setMovimientosFiles] = useState<FileSlot[]>([]);
  const [parseResult, setParseResult] = useState<TransformResult | null>(null);
  const [securities, setSecurities] = useState<SecurityInfo[]>([]);
  const [mappings, setMappings] = useState<Map<string, SecurityMapping>>(new Map());
  const [checked, setChecked] = useState<ActivityImport[] | null>(null);
  const [excludedLines, setExcludedLines] = useState<Set<number>>(new Set());
  const [showDuplicatesOnly, setShowDuplicatesOnly] = useState(false);

  const [fileError, setFileError] = useState<React.ReactNode>("");
  const [checkError, setCheckError] = useState("");
  const [importProgress, setImportProgress] = useState(0);
  const [importResult, setImportResult] = useState<ImportActivitiesResult | null>(null);
  const [failedActivities, setFailedActivities] = useState<{ activity: ActivityImport; error: string }[]>([]);

  useEffect(() => {
    Promise.all([loadSettings(ctx), ctx.api.accounts.getAll()]).then(([s, accs]) => {
      setSettings(s);
      setAccounts(accs.filter((a) => a.isActive && !a.isArchived));
    });
  }, []);

  const accountName = useCallback(
    (id: string): string => {
      if (!settings) return id;
      if (id === settings.accountId) return "MyInvestor";
      return accounts.find((a) => a.id === id)?.name ?? id;
    },
    [settings, accounts],
  );

  // ── Apply symbol mappings and run checkImport ─────────────────────────────

  const runCheckImport = useCallback(
    async (activities: ActivityImport[]) => {
      setStep("checking");
      try {
        const validated = await ctx.api.activities.checkImport(activities);
        setChecked(validated);
        setStep("confirm");
      } catch (e) {
        setCheckError(String(e));
        setChecked(activities);
        setStep("confirm");
      }
    },
    [ctx],
  );

  const runTransform = useCallback(
    async (fondos: FondosRow[], movimientos: MovimientosRow[]) => {
      if (!settings) return;

      // Another addon (e.g. trade-republic-importer-addon's Transfer
      // Patterns) may already have recorded a cross-account TRANSFER_IN for
      // money that also shows up here as a plain bank transfer — fetch what
      // already exists so transform() can avoid double-recording it as a
      // DEPOSIT. Also fetch our own already-imported DEPOSITs: since the two
      // addons' import order isn't controlled by either one, a DEPOSIT can
      // get created here before the matching TRANSFER_IN exists yet to dedup
      // against — passing both lets transform() retroactively detect that
      // now-confirmed duplicate on this (or any later) import, instead of
      // only ever preventing new ones going forward. Best-effort: an empty
      // list just means no dedup will happen.
      //
      // A cash movement (as opposed to an in-kind security transfer) is
      // identified by having NO linked asset — confirmed against a real
      // account export that Wealthfolio never actually attaches a
      // "$CASH-EUR"-style assetSymbol to DEPOSIT/TRANSFER_IN rows on
      // read-back (BUY/SELL rows for real funds do have one, e.g.
      // "0P0001XF3Z"). Checking for that prefix instead of absence made this
      // whole dedup mechanism silently match nothing, ever, since it was
      // first written.
      const isCashActivity = (a: { assetSymbol?: string }) =>
        !a.assetSymbol || a.assetSymbol.startsWith("$CASH");
      let existingCashTransfersIn: ExistingCashTransferIn[] = [];
      let existingDeposits: ExistingDeposit[] = [];
      try {
        const existing = await ctx.api.activities.getAll(settings.accountId);
        existingCashTransfersIn = existing
          .filter((a) => a.activityType === "TRANSFER_IN" && isCashActivity(a) && a.amount != null)
          .map((a) => ({
            id: a.id,
            date: new Date(a.date).toISOString().slice(0, 10),
            amount: Math.abs(parseFloat(a.amount as string)),
          }));
        existingDeposits = existing
          .filter((a) => a.activityType === "DEPOSIT" && isCashActivity(a) && a.amount != null)
          .map((a) => ({
            id: a.id,
            date: new Date(a.date).toISOString().slice(0, 10),
            amount: Math.abs(parseFloat(a.amount as string)),
          }));
      } catch {
        // non-critical — proceed without cross-addon dedup
      }

      // Non-EUR fund switches (traspasos) need a real historical exchange
      // rate to book their EUR cash impact correctly — without it Wealthfolio
      // creates a separate, never-funded currency bucket for the activity's
      // own currency (see fxRateKey/isForeignTraspaso in transform.ts). Batch
      // every unique (currency, date) pair into one lookup; best-effort, same
      // as the dedup fetch above — a failure here just means transform()
      // falls back to native-currency booking and surfaces a warning per row.
      // Keyed by fechaLiquidacion (settlement), not fechaOperacion (order
      // date) — see the comment on traspasoFxRate in transform.ts for why.
      let fxRates: Record<string, number> = {};
      try {
        const pairs = new Map<string, ExchangeRateDateQuery>();
        for (const r of fondos) {
          if (isForeignTraspaso(r)) {
            pairs.set(fxRateKey(r.divisa, r.fechaLiquidacion), {
              fromCurrency: r.divisa,
              toCurrency: "EUR",
              date: r.fechaLiquidacion,
            });
          }
        }
        if (pairs.size > 0) {
          const results = await ctx.api.exchangeRates.getRatesForDates([...pairs.values()]);
          fxRates = Object.fromEntries(
            results
              .filter((r) => r.rate != null)
              .map((r) => [fxRateKey(r.fromCurrency, r.date), r.rate as number]),
          );
        }
      } catch {
        // non-critical — transform() falls back to native-currency booking
      }

      const result = transform(fondos, movimientos, settings, existingCashTransfersIn, existingDeposits, fxRates);
      setParseResult(result);
      setChecked(null);
      setExcludedLines(new Set());
      setShowDuplicatesOnly(false);
      setCheckError("");

      const secMap = new Map<string, SecurityInfo>();
      for (const a of result.activities) {
        if (!a.symbol || a.symbol === "$CASH-EUR") continue;
        const existing = secMap.get(a.symbol);
        if (existing) {
          existing.count += 1;
        } else {
          secMap.set(a.symbol, { isin: a.symbol, name: a.symbolName ?? "", count: 1 });
        }
      }
      const secs = Array.from(secMap.values());
      setSecurities(secs);

      const prefilled = new Map<string, SecurityMapping>();
      for (const s of secs) {
        const known = settings.securityMappings[s.isin];
        if (known) prefilled.set(s.isin, known);
      }
      setMappings(prefilled);
      // Stays on the "upload" step — advancing is the user's call via the
      // Continue button below, not automatic on every file drop.
    },
    [settings],
  );

  // Decides where "Continue" on the upload step goes: straight to
  // validation when there's nothing to map (or everything's already
  // mapped from a prior import), otherwise the asset-mapping step.
  const proceedFromUpload = useCallback(() => {
    if (!parseResult) return;
    if (securities.length === 0) {
      void runCheckImport(parseResult.activities);
    } else if (securities.every((s) => mappings.has(s.isin))) {
      void runCheckImport(applySecurityMappings(parseResult.activities, mappings));
    } else {
      setStep("asset-review");
    }
  }, [parseResult, securities, mappings, runCheckImport]);

  const handleMappingsComplete = useCallback(
    (resolvedMappings: Map<string, SecurityMapping>) => {
      if (!parseResult) return;
      void runCheckImport(applySecurityMappings(parseResult.activities, resolvedMappings));

      if (settings) {
        const merged = { ...settings.securityMappings };
        for (const [isin, m] of resolvedMappings) merged[isin] = m;
        const next = { ...settings, securityMappings: merged };
        setSettings(next);
        void saveSettings(ctx, next);
      }
    },
    [parseResult, runCheckImport, settings, ctx],
  );

  // ── Upload & classify ─────────────────────────────────────────────────────

  // Adds a parsed file to its section's list (replacing any earlier upload
  // with the same name), then re-runs the transform against every uploaded
  // file's combined rows. Several files per section — e.g. one movimientos
  // export per month — are just concatenated; transform() already assigns
  // each row a stable, unique orderHint from its position in that combined
  // array, so no cross-file bookkeeping is needed here.
  const handleFiles = useCallback(
    async (files: File[], expectedKind: "movimientos" | "fondos") => {
      if (!settings) return;
      setFileError("");

      let nextFondosFiles = fondosFiles;
      let nextMovimientosFiles = movimientosFiles;

      for (const file of files) {
        let html: string;
        try {
          html = await readMyInvestorFile(file);
        } catch {
          setFileError(`Could not read ${file.name}.`);
          return;
        }
        const parsed = parseMyInvestorHtml(html);

        if (parsed.kind === "unknown") {
          const issueUrl = newFormatIssueUrl(file.name, describeUnknownFormat(html));
          setFileError(
            <>
              {file.name} wasn't recognised as a MyInvestor/Inversis export. Make sure you exported from
              "Operaciones y consultas" under either Cuenta &gt; Corriente or Inversiones &gt; Fondos.
              If you're sure it's a valid export, it may be a format this addon doesn't support yet —{" "}
              <a href={issueUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                report it on GitHub
              </a>
              .
            </>,
          );
          return;
        }

        // Dropped in the wrong box — e.g. a fondos file onto the Cuentas zone.
        // Surface a specific correction instead of silently misfiling it.
        if (parsed.kind !== expectedKind) {
          const droppedLabel = EXPORT_INFO[parsed.kind].title;
          const targetLabel = EXPORT_INFO[expectedKind].title;
          setFileError(`${file.name} looks like a ${droppedLabel} export — drop it in the ${targetLabel} box instead.`);
          return;
        }

        const slot: FileSlot = { fileName: file.name, rows: parsed.rows };
        if (parsed.kind === "fondos") {
          nextFondosFiles = [...nextFondosFiles.filter((f) => f.fileName !== file.name), slot];
        } else {
          nextMovimientosFiles = [...nextMovimientosFiles.filter((f) => f.fileName !== file.name), slot];
        }
      }

      setFondosFiles(nextFondosFiles);
      setMovimientosFiles(nextMovimientosFiles);
      void runTransform(
        nextFondosFiles.flatMap((f) => f.rows as FondosRow[]),
        nextMovimientosFiles.flatMap((f) => f.rows as MovimientosRow[]),
      );
    },
    [settings, fondosFiles, movimientosFiles, runTransform],
  );

  const removeFile = useCallback(
    (kind: "movimientos" | "fondos", fileName: string) => {
      const nextFondosFiles = kind === "fondos" ? fondosFiles.filter((f) => f.fileName !== fileName) : fondosFiles;
      const nextMovimientosFiles =
        kind === "movimientos" ? movimientosFiles.filter((f) => f.fileName !== fileName) : movimientosFiles;
      setFondosFiles(nextFondosFiles);
      setMovimientosFiles(nextMovimientosFiles);
      if (nextFondosFiles.length === 0 && nextMovimientosFiles.length === 0) {
        setParseResult(null);
        setSecurities([]);
        setMappings(new Map());
        return;
      }
      void runTransform(
        nextFondosFiles.flatMap((f) => f.rows as FondosRow[]),
        nextMovimientosFiles.flatMap((f) => f.rows as MovimientosRow[]),
      );
    },
    [fondosFiles, movimientosFiles, runTransform],
  );

  const toggleExclude = useCallback((lineNumber: number) => {
    setExcludedLines((prev) => {
      const next = new Set(prev);
      if (next.has(lineNumber)) next.delete(lineNumber);
      else next.add(lineNumber);
      return next;
    });
  }, []);

  const toggleAllDuplicates = useCallback(
    (duplicates: ActivityImport[]) => {
      const lines = duplicates
        .filter((a) => a.lineNumber != null)
        .map((a) => a.lineNumber as number);
      const allExcluded = lines.every((ln) => excludedLines.has(ln));
      setExcludedLines(() => {
        if (allExcluded) return new Set<number>();
        return new Set(lines);
      });
    },
    [excludedLines],
  );

  // ── Import ────────────────────────────────────────────────────────────────

  const handleImport = useCallback(async () => {
    if (!checked) return;

    const dups = checked.filter((a) => activityStatus(a) === "duplicate");
    const userSkippedCount = dups.filter(
      (a) => a.lineNumber != null && excludedLines.has(a.lineNumber),
    ).length;

    const candidates = checked.filter((a) => {
      if (activityStatus(a) === "error") return false;
      if (a.lineNumber != null && excludedLines.has(a.lineNumber)) return false;
      return true;
    });

    setImportProgress(0);
    setStep("importing");

    let importedCount = 0;
    let skippedCount = 0;
    const failed: { activity: ActivityImport; error: string }[] = [];
    try {
      for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i];
        const assetInput =
          a.symbol || a.assetId
            ? {
                id: a.assetId,
                symbol: a.symbol,
                name: a.symbolName,
                exchangeMic: a.exchangeMic,
                quoteCcy: a.quoteCcy,
                instrumentType: a.instrumentType,
                providerId: a.providerId,
                providerSymbol: a.providerSymbol,
              }
            : undefined;

        try {
          if (activityStatus(a) === "duplicate" && a.duplicateOfId) {
            const upd: ActivityUpdate = {
              id: a.duplicateOfId,
              accountId: a.accountId,
              activityType: a.activityType,
              subtype: a.subtype,
              activityDate: a.date as string,
              currency: a.currency,
              quantity: a.quantity,
              unitPrice: a.unitPrice,
              amount: a.amount,
              fee: a.fee,
              fxRate: a.fxRate,
              comment: a.comment,
              asset: assetInput,
            };
            await ctx.api.activities.update(upd);
          } else {
            const cre: ActivityCreate = {
              accountId: a.accountId,
              activityType: a.activityType,
              subtype: a.subtype,
              activityDate: a.date as string,
              currency: a.currency,
              quantity: a.quantity,
              unitPrice: a.unitPrice,
              amount: a.amount,
              fee: a.fee,
              fxRate: a.fxRate,
              comment: a.comment,
              asset: assetInput,
            };
            await ctx.api.activities.create(cre);
          }
          importedCount++;
        } catch (e) {
          skippedCount++;
          failed.push({ activity: a, error: String(e) });
        }
        setImportProgress(Math.round(((i + 1) / candidates.length) * 95) + 2);
      }
      setImportProgress(100);
      setFailedActivities(failed);

      const syntheticResult: ImportActivitiesResult = {
        activities: candidates,
        importRunId: "",
        summary: {
          total: candidates.length + userSkippedCount,
          imported: importedCount,
          skipped: skippedCount,
          duplicates: userSkippedCount,
          assetsCreated: 0,
          success: skippedCount === 0,
        },
      };
      setImportResult(syntheticResult);
      setStep("done");

      try {
        await ctx.api.portfolio.update();
        ctx.api.query.invalidateQueries([]);
      } catch {
        // non-critical
      }
    } catch (e) {
      setCheckError(String(e));
      setStep("confirm");
    }
  }, [checked, excludedLines, ctx]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setStep("upload");
    setFondosFiles([]);
    setMovimientosFiles([]);
    setParseResult(null);
    setSecurities([]);
    setMappings(new Map());
    setChecked(null);
    setExcludedLines(new Set());
    setShowDuplicatesOnly(false);
    setFileError("");
    setCheckError("");
    setImportResult(null);
    setImportProgress(0);
    setFailedActivities([]);
  }, []);

  const goBackToUpload = useCallback(() => {
    setStep("upload");
    setChecked(null);
    setCheckError("");
  }, []);

  // ────────────────────────────────────────────────────────────────────────────

  if (settings && !settings.accountId) {
    return (
      <div className="max-w-lg p-6">
        <Card>
          <CardContent className="space-y-3 p-6 text-center">
            <Icons.Settings className="text-muted-foreground mx-auto h-8 w-8" />
            <p className="font-medium">Settings not configured</p>
            <p className="text-muted-foreground text-sm">
              Please go to the <strong>Settings</strong> tab and select your MyInvestor/Inversis account before
              importing.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  if (step === "upload") {
    return (
      <div className="max-w-2xl space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Import MyInvestor / Inversis exports</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Uploading both gives the complete picture — fund detail plus the real EUR cash amount.
            Either one alone still works, with less detail. You can upload more than one file per
            section (e.g. one export per month).
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ExportUploadZone kind="movimientos" slots={movimientosFiles} onFiles={handleFiles} onRemove={removeFile} />
          <ExportUploadZone kind="fondos" slots={fondosFiles} onFiles={handleFiles} onRemove={removeFile} />
        </div>
        {fileError && <p className="text-destructive text-xs">{fileError}</p>}
        {parseResult && (fondosFiles.length > 0 || movimientosFiles.length > 0) && (
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">
              {parseResult.activities.length} activities parsed
              {parseResult.skipped.length > 0 && ` · ${parseResult.skipped.length} skipped`}
              {parseResult.duplicates.length > 0 &&
                ` · ${parseResult.duplicates.length} cross-addon duplicates`}
              {parseResult.fxRateWarnings.length > 0 &&
                ` · ${parseResult.fxRateWarnings.length} fx rate warnings`}
            </p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={proceedFromUpload} disabled={!parseResult}>
                Continue
              </Button>
              <Button variant="outline" onClick={reset}>
                Start over
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Asset Review ─────────────────────────────────────────────────────────

  if (step === "asset-review") {
    return (
      <SecurityMappingStep
        securities={securities}
        ctx={ctx}
        mappings={mappings}
        onMappingsChange={setMappings}
        onComplete={handleMappingsComplete}
        onBack={goBackToUpload}
      />
    );
  }

  // ── Checking ─────────────────────────────────────────────────────────────

  if (step === "checking") {
    const total = parseResult?.activities.length ?? 0;
    return (
      <div className="max-w-md space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Validating…</h1>
        <Progress value={undefined} className="animate-pulse" />
        <p className="text-muted-foreground text-sm">
          Checking {total} activities for duplicates and errors…
        </p>
      </div>
    );
  }

  // ── Confirm ───────────────────────────────────────────────────────────────

  if (step === "confirm" && checked) {
    const valid = checked.filter((a) => activityStatus(a) === "valid");
    const duplicates = checked.filter((a) => activityStatus(a) === "duplicate");
    const errors = checked.filter((a) => activityStatus(a) === "error");
    const userExcludedCount = duplicates.filter(
      (a) => a.lineNumber != null && excludedLines.has(a.lineNumber),
    ).length;
    const toImportCount = valid.length + duplicates.length - userExcludedCount;
    const unsupported = parseResult?.skipped ?? [];
    const crossAddonDuplicates = parseResult?.duplicates ?? [];
    const fxRateWarnings = parseResult?.fxRateWarnings ?? [];

    const visibleActivities = showDuplicatesOnly
      ? checked.filter((a) => activityStatus(a) === "duplicate")
      : checked;

    return (
      <div className="max-w-5xl space-y-4 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Review activities</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {valid.length} ready · {duplicates.length} duplicates · {errors.length} errors
              {unsupported.length > 0 && ` · ${unsupported.length} unsupported`}
              {crossAddonDuplicates.length > 0 &&
                ` · ${crossAddonDuplicates.length} cross-addon duplicates`}
              {fxRateWarnings.length > 0 && ` · ${fxRateWarnings.length} fx rate warnings`}
            </p>
            {checkError && (
              <p className="text-destructive mt-1 text-xs">
                Validation warning: {checkError} — review manually.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setStep(securities.length > 0 ? "asset-review" : "upload")}
            >
              Back
            </Button>
            <Button onClick={handleImport} disabled={toImportCount === 0}>
              Import {toImportCount} activities
            </Button>
          </div>
        </div>

        {duplicates.length > 0 && (
          <div className="bg-muted flex items-center justify-between rounded-lg px-4 py-3 text-sm">
            <span>
              <span className="font-medium">{duplicates.length} duplicate</span>
              {duplicates.length !== 1 ? "s" : ""} already exist in Wealthfolio — will be{" "}
              <strong>updated</strong> unless skipped.
            </span>
            <button
              onClick={() => toggleAllDuplicates(duplicates)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 ml-4 shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors"
            >
              {duplicates.every((a) => a.lineNumber != null && excludedLines.has(a.lineNumber))
                ? "Include all"
                : "Skip all"}
            </button>
          </div>
        )}

        <Card>
          <CardContent className="p-0">
            <Tabs defaultValue="activities">
              <div className="flex items-center justify-between px-3 pt-3">
                <TabsList>
                  <TabsTrigger value="activities">Activities ({checked.length})</TabsTrigger>
                  {crossAddonDuplicates.length > 0 && (
                    <TabsTrigger value="cross-addon-duplicates">
                      Duplicates ({crossAddonDuplicates.length})
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="unsupported">Unsupported ({unsupported.length})</TabsTrigger>
                  {fxRateWarnings.length > 0 && (
                    <TabsTrigger value="fx-rate-warnings">
                      FX rate warnings ({fxRateWarnings.length})
                    </TabsTrigger>
                  )}
                </TabsList>
                {duplicates.length > 0 && (
                  <button
                    onClick={() => setShowDuplicatesOnly((v) => !v)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                      showDuplicatesOnly
                        ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {showDuplicatesOnly
                      ? `Showing duplicates only (${duplicates.length})`
                      : `Show duplicates only (${duplicates.length})`}
                  </button>
                )}
              </div>

              <TabsContent value="activities" className="mt-0">
                <div className="max-h-[500px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-background sticky top-0 border-b">
                      <tr>
                        {["Date", "Account", "Type", "Symbol", "Amount", "Status"].map((h) => (
                          <th
                            key={h}
                            className="text-muted-foreground whitespace-nowrap px-2 py-1.5 text-left font-medium"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleActivities.map((a, i) => (
                        <ActivityRow
                          key={i}
                          activity={a}
                          accountName={accountName}
                          included={a.lineNumber == null || !excludedLines.has(a.lineNumber)}
                          onToggleInclude={() =>
                            a.lineNumber != null && toggleExclude(a.lineNumber)
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </TabsContent>

              {crossAddonDuplicates.length > 0 && (
                <TabsContent value="cross-addon-duplicates" className="mt-0">
                  <SkippedTable rows={crossAddonDuplicates} />
                </TabsContent>
              )}

              <TabsContent value="unsupported" className="mt-0">
                <SkippedTable rows={unsupported} />
              </TabsContent>

              {fxRateWarnings.length > 0 && (
                <TabsContent value="fx-rate-warnings" className="mt-0">
                  <SkippedTable rows={fxRateWarnings} />
                </TabsContent>
              )}
            </Tabs>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Importing ─────────────────────────────────────────────────────────────

  if (step === "importing") {
    return (
      <div className="max-w-md space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Importing…</h1>
        <Progress value={importProgress} />
        <p className="text-muted-foreground text-sm">Saving activities to Wealthfolio…</p>
      </div>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  if (step === "done" && importResult) {
    const { summary } = importResult;
    const hasIssues = !summary.success || (summary.skipped ?? 0) > 0;

    return (
      <div className="max-w-2xl space-y-4 p-6">
        <div className="flex items-center gap-3">
          {summary.success ? (
            <Icons.CheckCircle className="h-8 w-8 shrink-0 text-green-600" />
          ) : (
            <Icons.AlertCircle className="text-destructive h-8 w-8 shrink-0" />
          )}
          <div>
            <h1 className="text-2xl font-semibold">
              {summary.success ? "Import complete" : "Import finished with issues"}
            </h1>
            <p className="text-muted-foreground text-sm">
              {summary.imported} activities imported successfully.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold">{summary.total}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{summary.imported}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Imported</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-muted-foreground text-2xl font-bold">{summary.duplicates ?? 0}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Manually skipped</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-muted-foreground text-2xl font-bold">{summary.skipped ?? 0}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">Skipped</p>
            </CardContent>
          </Card>
        </div>

        {hasIssues && (
          <p className="text-muted-foreground text-sm">
            {summary.skipped ?? 0} activit{(summary.skipped ?? 0) === 1 ? "y" : "ies"} could not be
            saved — see the errors below.
          </p>
        )}

        {failedActivities.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-background sticky top-0 border-b">
                    <tr>
                      {["Date", "Type", "Symbol", "Amount", "Error"].map((h) => (
                        <th
                          key={h}
                          className="text-muted-foreground px-2 py-1.5 text-left font-medium"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {failedActivities.map((f, i) => (
                      <tr key={i} className="border-border/50 border-b">
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {fmtDate(String(f.activity.date))}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {f.activity.activityType}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 font-mono">
                          {f.activity.symbol ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 text-right">
                          {displayAmount(f.activity)}
                        </td>
                        <td className="text-destructive px-2 py-1">{truncate(f.error, 120)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <Button variant="outline" onClick={reset}>
          Import another file
        </Button>
      </div>
    );
  }

  return null;
}
