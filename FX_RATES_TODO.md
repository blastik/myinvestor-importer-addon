# TODO: fxRate for non-EUR fund switches (traspasos)

Blocked on a Wealthfolio core contribution to expose historical FX rates to addons. Once that lands, implement this.

## The bug

`transform.ts`'s traspaso branches (`SUSCR.POR TRASPASO I` / `ALTA IIC SWITCH` / `REEMB.POR TRASPASO I` / `BAJA IIC SWITCH`, ~line 204+) create `BUY`/`SELL` activities with `currency: r.divisa` and never set `fxRate` — unlike the `SUSCRIPCION`/`REEMBOLSO` branch above it, which derives `fxRate` from the matched movimientos EUR amount. Traspasos never have a movimientos counterpart (confirmed: 0/191 switch rows match any cash-ledger row), so there's nothing to derive a rate from today.

**Confirmed impact on a real account:** verified in Wealthfolio's own backend (`crates/core/src/portfolio/snapshot/holdings_calculator/handlers/trades.rs`, `handle_buy`/`handle_sell`):

```rust
if activity_currency != account_currency {
    if let Some(fx_rate) = activity.fx_rate_amt() {
        add_cash(state, account_currency, -(total_cost * fx_rate));
    } else {
        // No fx_rate — book in activity currency (multi-currency account)
        add_cash(state, activity_currency, -total_cost);
    }
} else {
    add_cash(state, activity_currency, -total_cost);
}
```

No `fxRate` + `currency != account currency` → Wealthfolio books cash into a **separate, never-funded currency bucket** instead of the account's real EUR cash. MyInvestor has no such bucket (single EUR cuenta corriente) — real account measured: **-76.40 USD stray balance**, exactly matching the sum of every USD-currency traspaso `BUY`/`SELL` with `fxRate: null`.

There's a second-order effect: the EUR leg of these same switches books *correctly* (same currency as account, no conversion needed), so redemption proceeds from an EUR fund that funded a USD-fund purchase show up as apparent "free cash" in the EUR bucket, since the offsetting USD-side debit never happens there. Measured on the same account: **+€51.25 net credit** across all EUR-side traspaso legs. `85.4537 (current EUR cash) − 51.2537 = 34.2000`, which matched the user's independently-known "true" MyInvestor cash balance to the cent — strong evidence both numbers are the same root cause, not two separate bugs.

## Why the obvious workarounds don't work (already tried, verified against real data)

1. **fondos' own "Importe neto" column** (`FondosRow.importe`) — not EUR. Confirmed empirically: for ~35/40 checked rows it's just `titulos × precio` rounded to 2 decimals in the fund's *own* currency (ratio ≈ 1.000 to native amount), not a converted EUR figure. Already documented as native currency in the type itself.
2. **Matching a switch's incoming (foreign) leg to its outgoing (funding) leg by date** — real MyInvestor switches have a multi-day settlement lag between the `BAJA`/`REEMB` (redemption) and `ALTA`/`SUSCR` (subscription) legs, no shared reference id links them, and grouping is genuinely many-to-many. Verified on the real account: the batch causing the -76 USD (2026-05-18, 5 fragments into `MSCI PACFC EXJAPN`) has no discoverable counterpart leg anywhere nearby (checked ±2 days, then the full `numOperacion` ordering — no match).
3. **A single "aggregate blended rate"** (back-solving one constant rate from `-51.2537 / 76.3963 ≈ 0.6708` so the known imbalance cancels exactly) — numerically tempting (see above) but explicitly rejected: it doesn't correspond to any real EUR/USD market rate for this period (real matched trades in the same fund show 0.85–1.00 across 2023–2026), it's curve-fit to one snapshot rather than derived, it would misstate per-transaction cost basis, and it doesn't generalize — every new switch import would shift the "right" constant.

## What's actually needed: real historical EUR/USD rates, per transaction date

Wealthfolio's backend already has this internally — `FxService::convert_currency_for_date(amount, from, to, date)` (`crates/core/src/fx/fx_service.rs`), backed by historical quotes synced via the market-data provider (same infra as stock/fund price history, `crates/core/src/fx/fx_model.rs`'s `FX:EUR/USD`-style instrument keys). It's used throughout `holdings_calculator/*` for cost-basis/lot conversion — but **not** exposed to addons, and **not** consulted by `handle_buy`/`handle_sell`'s cash-booking branch (that one requires an explicit `activity.fx_rate`, by design, presumably because cash bookkeeping shouldn't silently guess).

The addon-facing `exchangeRates.getAll()` API (`apps/server/src/api/exchange_rates.rs` → `/exchange-rates/latest`) only returns the **latest** rate per pair — confirmed by reading the actual route table (`get`, `put`, `post`, `delete`, no date param anywhere). No addon-facing historical lookup exists today.

**The plan:** contribute a new Wealthfolio core API exposing `fx_service.convert_currency_for_date()` to addons (e.g. `exchangeRates.getRateForDate(from, to, date)` or a small history endpoint), so this addon (and potentially trade-republic-importer-addon, which likely has the same class of need for foreign-currency activities) can pull a real, already-synced, provider-backed historical rate instead of each addon bolting on its own external API call.

## Once the host API exists, implement in this addon

1. In `ImportPage.tsx`'s `runTransform`, before calling `transform()`: collect every unique `(divisa, fechaOperacion)` pair among traspaso rows where `divisa !== "EUR"`, call the new host API for each, build a `Record<string, number>` keyed e.g. `` `${date}|${currency}` ``. Keep `transform()` itself pure — pass this map in as a new parameter (same pattern as `existingCashTransfersIn`/`existingDeposits`).
2. In `transform.ts`'s two traspaso branches (`SUSCR.POR TRASPASO I`/`ALTA IIC SWITCH` and `REEMB.POR TRASPASO I`/`BAJA IIC SWITCH`), when `r.divisa !== "EUR"`: look up the rate from the map and set `fxRate`, mirroring how the `SUSCRIPCION`/`REEMBOLSO` branch already does it (just without the movimientos-derived `eurAmount` — use the fetched historical rate directly: `fxRate = historicalRate`, `unitPrice` stays `r.precio` in native currency, `currency` stays `r.divisa`).
3. Handle a missing rate (host API failure, no data for that date/pair) gracefully: fall back to current native-currency booking (no `fxRate`) and push a `skipped`/warning entry so it's visible, not silent — don't crash the import.
4. Add tests mirroring the existing `SUSCRIPCION`/`REEMBOLSO` fxRate tests, plus a fixture case for a missing-rate fallback.
5. Update `CLAUDE.md`'s "USD-denominated funds" and traspaso sections to document the new behavior and the host API dependency (this addon would no longer be 100% offline for this one case).
6. Re-verify against the real account: EUR cash bucket should drop close to (not necessarily exactly) €34.20, USD phantom balance should go to ~$0. Don't expect an exact match to €34.20 — that number came from a coincidental aggregate-rate back-solve (~0.67), not real per-date rates (~0.85–1.00), so the real fix will land somewhere in that neighborhood, not necessarily the same cent.
7. Propose a semver bump (this changes transaction-mapping behavior) and add a CHANGELOG entry once shipped.

## Reference numbers (2026-07-10 snapshot, will drift with future imports — sanity-check the mechanism, not the exact figures)

- EUR cash bucket: €85.4537
- USD phantom bucket: -$76.3963
- Wealthfolio-displayed total (today's live FX): ~€18.54
- User-confirmed real MyInvestor balance: ~€34.20
- Net EUR-side traspaso switch effect: +€51.2537 (176 legs)
- Net USD-side traspaso switch effect: -$76.3963 (15 legs)
