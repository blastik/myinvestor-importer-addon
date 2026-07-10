# MyInvestor Importer Addon

Wealthfolio addon that merges two MyInvestor (Inversis) exports into a single account's activities. Core logic lives in `src/transform.ts` and `src/parseFiles.ts`; the React pages are thin wrappers calling the SDK.

## Quick Start (Claude Code Contributors)

```bash
pnpm install              # Install dependencies
pnpm test:watch           # Run tests in watch mode while developing
pnpm type-check           # Check TypeScript types
pnpm build                # Build to dist/addon.js
pnpm bundle                # Build + create ZIP for local Wealthfolio installation testing
```

## Stack

- **Runtime / package manager**: Node 24, pnpm 10 (versions pinned in `.tool-versions`)
- **Build**: Vite 7 — outputs a single `dist/addon.js` (ES module, no zip)
- **Tests**: Vitest 4 — `src/transform.test.ts` (pure logic) + `src/parseFiles.test.ts` (needs `happy-dom` for `DOMParser`, set via the `// @vitest-environment happy-dom` pragma at the top of that file only — `transform.test.ts` doesn't need DOM and stays on the fast default node environment) + `src/fixtures.test.ts` (end-to-end against sanitized real-export fixtures in `src/__fixtures__/`; stays on the default node environment and provides `DOMParser` from a manually-constructed `happy-dom` `Window` instead of the `@vitest-environment` pragma, because that pragma makes Vite 7/Vitest 4 externalize `node:fs`/`node:path` as browser stubs that throw at runtime — see the file for the workaround)
- **Type checking**: `tsc --noEmit`

## Key files

| File | Purpose |
|---|---|
| `src/parseFiles.ts` | HTML-table → typed row parsing for both export formats; ISO-8859-1 decoding |
| `src/transform.ts` | Pure row → ActivityImport mapping; all business logic, including the fondos/movimientos join |
| `src/transform.test.ts`, `src/parseFiles.test.ts` | Test suites |
| `src/fixtures.test.ts`, `src/__fixtures__/sample-*.xls` | End-to-end test against sanitized copies of real MyInvestor exports (fabricated ISINs/amounts/transfer concepts, real encoding/HTML quirks — no personal data) |
| `manifest.json` | Addon metadata; `version` here drives the release tag |
| `src/addon.tsx` | Entry point — registers pages and sidebar item via addon-sdk |

## Single-account model

Unlike Trade Republic (cash account + portfolio account, requiring `TRANSFER_OUT`/`TRANSFER_IN` cash pairs to fund every buy), MyInvestor keeps cash and securities in **one account**. A `BUY`/`SELL` activity directly debits/credits that account's cash — no internal transfer plumbing needed. This is why `transform.ts` never sets `sourceGroupId`/a transfer-group id on any activity, unlike the trade-republic-importer-addon it's modeled after.

## The two export files, and why both are needed

MyInvestor's data is split across two unrelated exports from inversis.com, and neither alone is complete:

- **"movimientos"** (`Cuenta > Corriente > Operaciones y consultas > Movimientos`) — the EUR cash ledger. Has deposits, fees, interest, and the EUR cash side of every real fund buy/sell (`SUSCRIPCION IIC`/`REEMBOLSO IIC`), but **no ISIN, no quantity, no native price** — just a free-text concept string like `"FIDELITY MSCI JAPAN INDEX P AC @ 0.504"` where `0.504` is the share count.
- **"fondos"** (`Inversiones > Fondos > Operaciones y consultas > Consulta de operaciones`) — fund-level detail (ISIN, quantity, native-currency price) for every fund movement, including tax-free switches (*traspasos*) that **never appear in movimientos at all** (verified against real data: 0 of 191 traspaso/switch rows have any cash-ledger counterpart).

`SUSCRIPCION`/`REEMBOLSO` rows appear in **both** files for the same real-world transaction and must be merged into one `BUY`/`SELL`, not double-imported. The join key is `fondos.fechaLiquidacion === movimientos.fechaValor` plus the share count embedded after the last `@` in the movimientos `concepto` (parsed by `conceptShares()` in `transform.ts`, tolerance `0.001`). This was verified 1:1 against real exports — every plain `SUSCRIPCION`/`REEMBOLSO` row matched exactly one cash row and vice versa.

Both HTML files are auto-detected by header content in `parseMyInvestorHtml()` (`ISIN` → fondos, `Tipo de operaci` → movimientos) — upload order doesn't matter, and either file alone is accepted (see degraded-mode behavior below).

## Fund switches (traspasos) are BUY/SELL — TRANSFER_IN/OUT was tried and reverted

`SUSCR.POR TRASPASO I`/`ALTA IIC SWITCH` (incoming) and `REEMB.POR TRASPASO I`/`BAJA IIC SWITCH` (outgoing) represent Spain's tax-deferred fund-to-fund exchange — no capital gain is realized for tax purposes, and they're cash-neutral by construction (confirmed against real data: never touch the movimientos ledger).

**History, because this reasoning is easy to re-derive backwards into the wrong conclusion:** the first version mapped these to `TRANSFER_IN`/`TRANSFER_OUT` instead of `SELL`/`BUY`, specifically because `TRANSFER_OUT` forces `disposal_proceeds = cost_basis_removed` — guaranteeing **zero realized P&L** — unlike `SELL`, which books a real (but fiscally phantom) gain/loss. Each leg was left independent (no shared `sourceGroupId`) because real MyInvestor switches are frequently many-to-many (e.g. one date: 11 small `ALTA` fragments into one fund, funded by 2 `BAJA` fragments from two *different* funds), and grouping was judged too risky to verify.

**That was wrong, confirmed against a real user's account with a live number to check against (MyInvestor's own "Invertido" figure vs. Wealthfolio's `net_contribution`):** `handlers/transfers.rs:391` — `state.net_contribution += cost_basis_acct` — runs **unconditionally** for every `TRANSFER_IN`, paired or not. An unpaired `TRANSFER_IN` books the full switch-day value as new capital; the matching `TRANSFER_OUT` only subtracts the *original* cost basis of the removed lots (not the current value) from `net_contribution`. Whenever a switched fund had appreciated since it was first bought — completely normal for a multi-year index-fund DCA account — the gap between what's added and what's subtracted doesn't cancel. Measured on a real ~2.7-year account history: **€711 of inflation** (confirmed by cross-referencing MyInvestor's own "Invertido" total against Wealthfolio's `net_contribution` for the same account). This is not cosmetic — it corrupts a headline portfolio metric, on top of the 191 "incomplete transfer" health-check warnings the ungrouped legs also produce (`validate_asset_shape` in `activities/transfer_pairs.rs` requires same-asset pairs; a cross-asset switch always fails it).

**Grouping (shared `sourceGroupId`) is not a safe fix either**, so don't reach for it as the answer: `transfers.rs:150-281` shows a grouped `TRANSFER_IN` pulls the *literal cached `Lot` objects* from the paired `TRANSFER_OUT`'s `run.transfer_lots_cache` and reattaches them verbatim onto the new asset's position — for a same-asset transfer (the mechanism's actual intended use: identical shares moving between brokers) that's correct, but for a cross-asset switch it would silently give the new fund the *old* fund's quantity and cost basis instead of its own. That trades a `net_contribution` bug for a holdings-corruption bug.

**Current, correct model: `BUY`/`SELL` at switch-day price**, independent (no pairing needed — `handlers/trades.rs` never references `net_contribution` at all, confirmed by inspection). Quantities/cost-basis are unaffected (verified against real data both before and after this change), the 191 health-check warnings disappear (self-contained activities need no pairing), and `net_contribution` is exact. The accepted cost: every switch now shows as a real (non-taxable-in-Spain) realized gain/loss in performance/tax reports. If a future contributor is tempted to "fix" this by going back to TRANSFER_IN/OUT to suppress phantom realized gains, re-read this section first — that tradeoff was already tried, measured, and rejected for a worse, silent, harder-to-notice problem.

## USD-denominated funds — one EUR account, not two

MyInvestor settles even USD-denominated fund trades in EUR from the single cuenta corriente (verified: the one USD fund in real sample data, `MSCI PACFC EXJAPN...`, produces **zero** USD rows in movimientos — always EUR). There is deliberately **no separate USD account/`transfer_in`/`transfer_out` pattern** here (unlike an earlier design hypothesis) — Wealthfolio's backend (`crates/core/.../handlers/trades.rs`) honors an explicit `fxRate` on `BUY`/`SELL` directly to compute the EUR cash impact from `quantity * unitPrice`, exactly like the trade-republic-importer-addon already does for foreign-currency `DIVIDEND`. `transform.ts` computes `fxRate = eurAmountFromMovimientos / (titulos * precio)` only when `divisa !== "EUR"`.

**`fxRate` is a no-op when activity currency == account currency** — confirmed in `handlers/trades.rs:203-213`: the fx-rate branch is only entered `if activity_currency != account_currency`; when they're equal (our EUR trades against the EUR account), cash always books as raw `quantity * unitPrice`, full stop, no override possible via `fxRate` or `amount` (per `economics.rs`'s `should_use_activity_amount`, `amount` is only consulted for BUY/SELL when quantity or unitPrice is missing or the asset is a bond — never our case). MyInvestor's stated "Precio Neto" has a small residual vs. the real EUR debited (NAV rounding, ~0.6 cents/trade average) that first looked immaterial but **accumulates across hundreds of trades into a real account-balance mismatch** (confirmed against real data: shipped 0.1.2 with this treated as immaterial, then 0.1.3 fixed it after a user-reported balance discrepancy of ~€1.09 traced directly to this). The fix: for EUR-currency matched trades, `unitPrice` is derived as `eurAmountFromMovimientos / titulos` instead of using MyInvestor's stated price — quantity stays exactly correct, and quantity × unitPrice now matches the real cash debit to the cent. This nudges per-lot cost basis by the same negligible residual, which is the right trade since cash-balance accuracy compounds across the whole ledger while cost-basis drift doesn't.

## Cartera Indexada is cash-only, by explicit user decision

MyInvestor's separate robo-advisor "Cartera Indexada" product (recurring `ABONO POR TRASPASO`/`CARGO POR TRASPASO` rows, `COMISION GESTION CARTERA OF` fees) has no fund-level detail in either export. Per explicit user decision during this addon's design, it is imported as plain cash movements (`DEPOSIT`/`WITHDRAWAL`/`FEE`) and is **not** modeled as a holding/position — don't try to reverse-engineer an underlying fund breakdown for it.

## Wealthfolio's idempotency key is description-based, not id-based — every activity comment must be unique

Confirmed straight from `crates/core/src/activities/idempotency.rs`: the dedup hash is `account_id|activity_type|date(DAY ONLY, time discarded)|asset_id|quantity|unit_price|amount|currency|provider_reference_id|description`. There's no per-row id field we control, and `activityDate`'s time component is thrown away before hashing. MyInvestor's traspaso/switch exports routinely split one transfer into several same-day fragments landing on the same fund at the exact same NAV (identical quantity *and* price) — real distinct transactions that hash identically. `transform()`'s final pass appends `[ref:${orderHint}]` (fondos `numOperacion`, or file index for movimientos-only rows — both stable across re-imports of the same export) to every comment specifically to prevent this. **Any new activity-producing branch must go through this same final `drafts` pass — never build a comment that bypasses it**, or it reintroduces exactly the silent-data-loss bug this addon shipped 0.1.1 to fix (see CHANGELOG). This is the same category of gotcha the trade-republic-importer-addon's own `timeTag()` comment documents (that addon tags the *time-of-day* into the comment for the same underlying reason — description-uniqueness, not date-uniqueness).

## Cross-addon transfer dedup

If the user also tracks another broker in Wealthfolio (e.g. Trade Republic via trade-republic-importer-addon's Transfer Patterns with a `destinationAccountId` pointed at this MyInvestor account), the same real-world money movement can get recorded twice: once as a `TRANSFER_IN` by the other addon, and again here as a `DEPOSIT` from the matching `TRANSFERENCIA SEPA`/`TRANSFERENCIA INMEDIATA` movimientos row. Wealthfolio's own duplicate detection never catches this — `DEPOSIT` and `TRANSFER_IN` are different `activity_type`s, so they hash to different idempotency keys regardless of how well everything else matches.

`transform()` takes an optional `existingCashTransfersIn: ExistingCashTransferIn[]` parameter (pre-fetched by `ImportPage.tsx` via `ctx.api.activities.getAll(accountId)`, filtered to `TRANSFER_IN` rows identified as cash movements) and skips generating a `DEPOSIT` for `TRANSFERENCIA SEPA`/`TRANSFERENCIA INMEDIATA` rows that match an existing one by amount (exact) and date (±1 day) — surfaced in `TransformResult.duplicates` for review rather than silently dropped. Deliberately scoped to just those two `tipo`s: `ABONO POR TRASPASO` is an internal Cartera Indexada flow (see above), not a cross-broker bank transfer, so it's not checked against this list. This is a heuristic (amount+date matching, not a shared id — neither addon can see the other's data), so a genuine coincidence (two unrelated transfers of the exact same amount within a day of each other) would be a false positive; that's an acceptable tradeoff over silently double-counting real transfers, and the skip is reviewable, not silent.

`duplicates` is a separate list from `skipped`/the "Unsupported" tab, rendered in `ImportPage.tsx` as its own "Duplicates" tab — a duplicate finding means nothing's wrong with the row (it's just already recorded, one way or another), which is a different kind of review item than "this addon doesn't know how to handle this fondos/movimientos row type." Burying an actionable "go delete this specific activity" warning inside generic unsupported-row noise made it easy to miss during testing.

**A cash movement is identified by having no linked asset, not by a `$CASH`-prefixed `assetSymbol`.** The first version of this filter checked `assetSymbol?.startsWith("$CASH")`, on the assumption that `cashAct()`'s `symbol: "$CASH-EUR"` (set when *creating* the activity) would round-trip back through `ctx.api.activities.getAll()` on the next import. It doesn't: confirmed against a real account's CSV export and MCP activity data that `DEPOSIT`/`TRANSFER_IN` rows always come back with an **empty** `assetSymbol`, regardless of which addon created them — real funds (`BUY`/`SELL`) do have a populated one (e.g. `0P0001XF3Z`), so Wealthfolio evidently accepts the `$CASH-EUR` hint for import-time classification but never attaches an asset to the resulting cash activity. Because the filter required a non-empty prefix match, `existingCashTransfersIn` (and `existingDeposits`, below) were **silently always empty**, from day one — the whole cross-addon dedup mechanism never fired once, in either direction, regardless of import order. Confirmed by reproducing on a real account: even with trade-republic-importer-addon's `TRANSFER_IN` created *before* running this addon's import, all 8 matching `TRANSFERENCIA SEPA`/`INMEDIATA` rows still got imported as duplicate `DEPOSIT`s. The fix is `!a.assetSymbol || a.assetSymbol.startsWith("$CASH")` — treat "no asset at all" as the cash signal, keeping the prefix check only as a fallback for a Wealthfolio version/config that does populate it.

**Import order isn't controlled by either addon, and this dedup alone can't undo a duplicate already created.** Confirmed against a real account: 8 recurring transfers had *both* a `TRANSFER_IN` (created by trade-republic-importer-addon's Transfer Patterns) and a matching `DEPOSIT` (created by this addon) for the same date/amount — inflating the account's cash balance by the full duplicated total (€1,000 in that case). The forward-looking check above only ever prevents a *new* `DEPOSIT` from being created; if this addon's import ran first (before the other addon's `TRANSFER_IN` existed yet), there was nothing to dedup against at that moment, and once both exist there's no mechanism to retroactively fix the one already made — Wealthfolio's own idempotency won't help either, since the addon can't delete activities (`@wealthfolio/addon-sdk`'s `activities` API only exposes `getAll`/`create`, no delete/update).

The fix: `transform()` also takes an optional `existingDeposits: ExistingDeposit[]` parameter (same shape and fetch site as `existingCashTransfersIn`, filtered to `DEPOSIT` instead of `TRANSFER_IN`). Every import re-scans the *entire* movimientos history (not just new rows), so on each run — including one that adds no new data at all — every `TRANSFERENCIA SEPA`/`TRANSFERENCIA INMEDIATA` row gets re-checked against the *current* state of both lists. When a row matches an existing `TRANSFER_IN` **and** a `DEPOSIT` for the same amount/date already exists too, `skipped` gets a distinctly worded, actionable entry (containing both activity ids) telling the user this is now a confirmed duplicate to delete manually — instead of the generic "not creating a duplicate" message, which only makes sense for a `DEPOSIT` that was never created in the first place. This can't auto-heal past duplicates (no delete capability), but it turns "silently stays broken forever" into "flagged every time you import, with enough detail to fix it in one click in the app."

This retroactive check was written and shipped before the `assetSymbol` filter bug (above) was found, and inherited it — `existingDeposits` was fetched with the same broken predicate, so it was empty too, and the retroactive check never got a chance to fire regardless of import order. Confirmed only by testing against a real account: even with trade-republic-importer-addon's `TRANSFER_IN` created deliberately *before* this addon's import (the case this retroactive check exists for), the duplicate `DEPOSIT`s still got created — proving the bug was the empty-`assetSymbol` filter, not import order. Both are fixed together now; keep the retroactive check regardless, since import order still isn't controlled by either addon and the failure mode it guards against is real.

## Degraded single-file imports

`transform()` accepts either input array empty and still produces useful output:

- Fondos-only: traspasos/switches work fully (never needed cash data). Plain `SUSCRIPCION`/`REEMBOLSO` still import as `BUY`/`SELL` but without a verified `fxRate` (native-currency booking).
- Movimientos-only: all cash-only activity types (fees, interest, deposits, etc.) work fully. `SUSCRIPCION IIC`/`REEMBOLSO IIC` rows are skipped (no ISIN/quantity available) and surfaced in the "Unsupported" tab for manual review — never silently dropped.

## Releasing

Same gate as the trade-republic-importer-addon this is modeled after: the release workflow only creates a GitHub release when `manifest.json`'s version has no matching git tag yet. Whenever a change touches `src/`, `manifest.json` permissions/metadata, or transaction-mapping behavior, proactively propose a semver bump before merging. Apply it to both `manifest.json` and `package.json`, add a `CHANGELOG.md` entry, then push/merge to `main`.
