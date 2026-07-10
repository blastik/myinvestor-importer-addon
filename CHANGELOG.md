# Changelog

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
