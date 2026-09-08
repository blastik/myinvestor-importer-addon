# Changelog

## [1.3.2] - 2026-09-08

### Fixed

- The Cuentas/movimientos upload box's on-screen menu path (shown when a dropped file isn't recognised) said `Cuenta > Corriente > Operaciones y consultas > Consulta de operaciones` — the trailing segment was actually the fondos screen's menu label, copy-pasted in by mistake. The real Inversis menu (confirmed against a live screenshot) is `Cuentas > Corriente > Operaciones y consultas > Movimientos`. Also corrected in README.md and CLAUDE.md, which had the same wrong text.

## [1.3.1] - 2026-09-08

### Fixed

- Non-EUR fund switches (traspasos) now look up their historical FX rate by `fechaLiquidacion` (settlement date) instead of `fechaOperacion` (order date). The two dates were confirmed to diverge by up to a week on a real account, and the order-date lookup was pulling the wrong day's exchange rate on every affected switch — an avoidable source of drift on top of the inherent approximation of using a third-party historical rate instead of Inversis' own internal conversion rate. Confirmed against a real ~2.9-year account (fully reconciled otherwise — 0 unexpected skips, every fund's share count matching the broker's own holdings screen exactly) where this was responsible for a €14.72 EUR cash-balance shortfall against the broker's own "Saldo Final".

## [1.3.0] - 2026-09-08

### Added

- Support for a second, 7-column movimientos ("Cuenta > Corriente > Movimientos") export shape — confirmed to be what current real MyInvestor accounts actually produce (`Movimientos de cuentas` title, `Cargo/Abono` indicator + running `Saldo` columns, no `Divisa` column). Files in this shape were previously rejected outright as "not a MyInvestor export".
- Fund `SUSCRIPCION`/`REEMBOLSO` rows now also join to their cash counterpart by fund-name similarity when the movimientos `Concepto` carries no share-count suffix (true for the 7-column shape above, and confirmed to vary row-by-row even within one real account's history) — still deriving the exact cash-based price/`fxRate`, not settling for a native-price guess or skipping a real match.
- Unrecognized-file errors now include a "report it on GitHub" link, prefilled with a structural-only diagnostic (the file's `<title>`, header text, and a `<td>`-count-per-row histogram) — deliberately excludes actual cell content (dates/amounts/fund names).
- Two separate upload boxes (Cuentas / Inversiones) instead of one combined drop zone, rejecting a file dropped in the wrong box with a specific correction instead of silently misfiling it. Each box accepts more than one file (e.g. one export per month) instead of only the most recent upload.

### Changed

- Uploading a file no longer jumps straight to validation/mapping — the user reviews the parsed row/skip counts and clicks **Continue** to proceed, so a mis-dropped file (or one of several files still to add) can be reviewed or removed first instead of the import racing ahead automatically.
- `src/__fixtures__/sample-movimientos.xls` now uses the real 7-column shape (previously 6-column) so the end-to-end suite exercises what real accounts actually export.
- Updated CLAUDE.md/README to document both movimientos shapes and the fund-name-matching fallback trade-off.
- Settings/README account-picker copy now explicitly says to select the securities/investment account, not a separate cash/checking account, to head off a real point of confusion around MyInvestor's "cuenta corriente" naming.
- Documented that this addon's scope is the securities/investment account only — a separate personal cash/checking account (BIZUM, card purchases, loan payments, no fund activity) isn't supported and would need a Trade Republic–style two-account mapping that doesn't exist yet.
- Removed the broken inversis.com deep links from the upload UI.

## [1.2.0] - 2026-09-08

### Fixed

- Non-EUR fund switches (traspasos: `SUSCR.POR TRASPASO I` / `ALTA IIC SWITCH` / `REEMB.POR TRASPASO I` / `BAJA IIC SWITCH`) were booked with no `fxRate`, since — unlike `SUSCRIPCION`/`REEMBOLSO` — a traspaso has no movimientos cash counterpart to derive one from. Wealthfolio books an activity with no `fxRate` into its own currency when that differs from the account currency, so every non-EUR switch created a separate, never-funded currency bucket instead of touching the account's real EUR cash (confirmed on a real account: a stray phantom USD balance exactly matching the sum of every USD switch, paired with matching phantom "free" EUR cash on the funding side).

### Added

- `ImportPage.tsx` now batch-resolves a real historical EUR exchange rate for every non-EUR traspaso row via `ctx.api.exchangeRates.getRatesForDates` (added in `@wealthfolio/addon-sdk` 3.8.0 / Wealthfolio 3.8.0, [wealthfolio/wealthfolio#1276](https://github.com/wealthfolio/wealthfolio/pull/1276)) and passes the results into `transform()`, which sets `fxRate` on the matching BUY/SELL. A rate that can't be resolved falls back to the previous native-currency booking and is now surfaced in a new `fxRateWarnings` list (its own "FX rate warnings" tab during import review) instead of silently landing in the wrong currency bucket with no indication.
- New `currency` permission (`getRatesForDates`) declared in `manifest.json`.

### Changed

- Bumped `minWealthfolioVersion`/`sdkVersion`/host dependency ranges to 3.8.0 (required for `exchangeRates.getRatesForDates`).

## [1.1.0] - 2026-08-31

### Added

- Added support for Inversis.com movimientos operation labels found in brokerage exports, including:
	- `COMPRA RV CONTADO SF` / `COMPRA RV CONTADO` -> `BUY`
	- `VENTA DE VALORES` -> `SELL`
	- `COMPRA RF VCTO` -> `BUY` (`BOND`, e.g. Letras del Tesoro)
	- `AMORTIZACION RF` -> `SELL` (`BOND`)
	- `ABONO DE DIVIDENDO` -> `DIVIDEND` for positive amounts, and `FEE` (subtype `REVERSAL`) for negative reversal lines (e.g. `ANUL.`) — a real cash outflow like `WITHDRAWAL`, but (unlike `WITHDRAWAL`) doesn't inflate `net_contribution`, matching how the original dividend credit never affected it either.
	- `COMISIONES CUSTODIA` (alternate custody-fee label) -> `FEE`
- Added support for personal current-account movimientos rows found in real exports:
	- `BIZUM ENVIADO` -> `WITHDRAWAL`, `BIZUM RECIBIDO` -> `DEPOSIT`
	- `COMPRA COMERCIO O/L` (card purchase) -> `WITHDRAWAL`
	- `TRANSF INMEDIATA EMITIDA` -> `WITHDRAWAL`
- Added parsing of instrument name and quantity from movimientos `Concepto` values in the format `<instrument> @ <quantity>` for stock/bond/dividend rows. A dividend row whose concept has no parseable instrument/quantity is surfaced under "Unsupported" rather than imported against a made-up symbol.
- Extended the shared anonymized fixtures (`src/__fixtures__/sample-movimientos.xls`) with rows covering every transaction type above, asserted end-to-end in `src/fixtures.test.ts`.

### Changed

- Added parser coverage for mojibake header variants such as `Tipo de operación`.
- Updated dependencies: `@vitejs/plugin-react` 6.1.0 → 6.1.1, `happy-dom` 20.11.6 → 20.11.15

## [1.0.2] - 2026-08-24

### Changed

- Updated dependencies: `@wealthfolio/addon-sdk`/`ui`/`addon-dev-tools` 3.6.1 → 3.7.0, `react`/`react-dom` 19.2.7 → 19.2.8, `tailwindcss`/`@tailwindcss/vite` 4.3.2 → 4.3.3, `vitest` 4.1.10 → 4.1.11, `happy-dom` 15 → 20, `vite` 7 → 8, `@vitejs/plugin-react` 4 → 6, `typescript` 5.9 → 7.0, `@types/node` pinned to the latest 24.x release matching this addon's pinned Node 24 runtime (not the newer 26.x types)
- Bumped CI/release workflow actions: `actions/checkout` v4 → v7, `actions/setup-node` v4 → v7, `pnpm/action-setup` v4 → v6, `softprops/action-gh-release` v2 → v3
- Added `.github/dependabot.yml` for monthly automated dependency-update PRs (npm + github-actions ecosystems)

## [1.0.1] - 2026-07-10

### Fixed

- Cross-addon transfer dedup never actually matched anything: the filter checked for a `$CASH`-prefixed `assetSymbol` on existing `DEPOSIT`/`TRANSFER_IN` activities, but Wealthfolio never attaches an asset to cash-type activities on read-back (confirmed against a real account export) — so `existingCashTransfersIn` was silently empty from day one, regardless of import order. A real account had ended up with 8 duplicated transfers (€1,000) as a result. Fixed to detect a cash activity by the absence of a linked asset instead.
- Added retroactive detection: since the addon can't delete activities it already created, every import now re-checks the *entire* movimientos history against current `TRANSFER_IN`/`DEPOSIT` state, so a duplicate created before its counterpart existed still gets flagged (with both activity ids) on a later import instead of staying silently stuck forever.

### Changed

- Cross-addon duplicate findings now show in their own "Duplicates" tab during import review, separate from "Unsupported" — a duplicate means the row is fine and already recorded elsewhere, which needs a different response than "this addon can't process this row type."

## [1.0.0] - 2026-07-10

### Added

- Import MyInvestor (Inversis) exports into a single Wealthfolio account — cash and securities share one account, so a `BUY`/`SELL` directly debits/credits cash with no internal transfer plumbing needed
- Joins the "movimientos" (cuenta corriente) and "consulta de operaciones" (fondos) exports by settlement date + share count, merging `SUSCRIPCION`/`REEMBOLSO` into single `BUY`/`SELL` activities whose cash impact (`quantity * unitPrice`) reconciles exactly to the real EUR debit, rather than drifting from MyInvestor's stated NAV-rounded price
- Tax-free fund switches (traspasos: `SUSCR.POR TRASPASO I` / `REEMB.POR TRASPASO I` / `ALTA IIC SWITCH` / `BAJA IIC SWITCH`) modeled as independent `BUY`/`SELL` at switch-day price — keeps Wealthfolio's `net_contribution` ("invested") figure accurate and avoids "incomplete transfer" health-check warnings that a cross-asset transfer pairing would otherwise trigger
- USD-denominated funds booked with an explicit `fxRate` derived from the real EUR cash amount, so cash settles exactly in EUR from the single cuenta corriente without needing a separate USD account
- Cash-only movimientos rows mapped to `FEE` / `INTEREST` / `TAX` / `CREDIT` / `DEPOSIT` / `WITHDRAWAL` — custody and management fees, VAT, interest, withholding tax, promo credits, deposits/withdrawals, and Cartera Indexada cash flows
- Cross-addon transfer dedup: skips creating a duplicate `DEPOSIT` for a bank transfer already recorded as a `TRANSFER_IN` by another addon (e.g. trade-republic-importer-addon's Transfer Patterns), matched by amount and date and surfaced for review instead of silently dropped
- Graceful degradation when only one of the two export files is uploaded — fondos-only still imports traspasos fully; movimientos-only still imports all cash-only activity types, with unmatched fund rows surfaced for manual review
- Every activity comment tagged with a stable per-row reference so same-day, same-fund, same-NAV traspaso fragments and coincidental duplicate deposits don't collapse into one activity under Wealthfolio's description-based idempotency key
- Security mapping step for unrecognised fund ISINs, persisted across imports so recurring imports don't require re-mapping
- Settings page for account selection and security mapping management
- Unit tests for the parsing/transform logic plus an end-to-end test against sanitized real MyInvestor export fixtures
