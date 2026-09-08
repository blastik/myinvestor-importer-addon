# MyInvestor / Inversis Importer

A Wealthfolio addon that imports MyInvestor and Inversis account exports into your portfolio.

## Overview

Getting the full picture requires **two exports** from inversis.com, because
neither one alone has everything:

- **Movimientos** (`Cuentas > Corriente > Operaciones y consultas > Movimientos`) —
  the EUR cash ledger: deposits, fees, interest, and the EUR cash side of
  every real fund buy/sell. Two export shapes are auto-detected — a 6-column
  one whose concept text always carries the fund's share count, and a
  7-column one that usually doesn't (see below for how fund buys/sells still
  get matched to their cash movement either way).
- **Fondos** (`Inversiones > Fondos > Operaciones y consultas > Consulta de operaciones`) —
  fund-level detail (ISIN, quantity, native-currency price) for every fund
  movement, including tax-free fund switches (*traspasos*) that never touch
  cash and only appear here.

Both exports are HTML tables saved with an `.xls` extension — the addon reads
them directly, no conversion needed.

**Scope note:** this addon targets your MyInvestor/Inversis **securities/investment
account** only. If your bank also has a separate personal current/checking
account (BIZUM, card purchases, loan payments, no fund activity), importing
that into the same Wealthfolio account isn't supported yet — it would need a
Trade Republic–style two-account (cash + securities) mapping, which doesn't
exist here.

## Setup

1. Install the addon:
   - Download the `myinvestor-importer-addon.zip` asset from the
     [latest release](https://github.com/blastik/myinvestor-importer-addon/releases/latest)
   - In Wealthfolio, go to **Settings → Add-ons**, click **Install from File**, and
     select the downloaded zip
2. Go to **MyInvestor → Settings**
3. Select your **MyInvestor/Inversis securities/investment account** — the one that holds your
   funds, not a separate cash/checking account

## Importing

1. Go to **MyInvestor → Import**
2. Export and drop each file into its own box — you can drop more than one
   file per box (e.g. one export per month)
3. Click **Continue**, then review the parsed activities — duplicates are
   detected automatically
4. Map any unrecognised funds to their correct ticker (Security Mapping step)
5. Click **Import**

You can import with just one file if you don't have the other, but you'll get
a smaller/less accurate picture — see below.

## Supported Transaction Types

| Source rows | Wealthfolio activity |
| --- | --- |
| `SUSCRIPCION` (fondos) + `SUSCRIPCION IIC` (movimientos), joined by settlement date + share count when the movimientos export includes one (see "Two movimientos export shapes" below) | `BUY` |
| `REEMBOLSO` (fondos) + `REEMBOLSO IIC` (movimientos) | `SELL` |
| `SUSCR.POR TRASPASO I` / `ALTA IIC SWITCH` (fondos only — no cash impact) | `BUY` at switch-day price (non-EUR funds get a historical `fxRate`, see below) |
| `REEMB.POR TRASPASO I` / `BAJA IIC SWITCH` (fondos only — no cash impact) | `SELL` at switch-day price (non-EUR funds get a historical `fxRate`, see below) |
| `COMPRA RV CONTADO SF` / `COMPRA RV CONTADO` (movimientos) | `BUY` (symbol/quantity parsed from concept, EUR unit price derived from amount/quantity) |
| `VENTA DE VALORES` (movimientos) | `SELL` (symbol/quantity parsed from concept, EUR unit price derived from amount/quantity) |
| `COMPRA RF VCTO` (movimientos) | `BUY` bond |
| `AMORTIZACION RF` (movimientos) | `SELL` bond |
| `ABONO DE DIVIDENDO` positive | `DIVIDEND` (skipped for review if the concept has no `<instrument> @ <quantity>` to identify the security) |
| `ABONO DE DIVIDENDO` negative (e.g. `ANUL.` reversal line) | `FEE` (subtype `REVERSAL`) — a real cash outflow like `WITHDRAWAL`, but doesn't inflate `net_contribution` |
| `COMISION CUSTODIA MYINVESTOR`, `COMISIONES CUSTODIA`, `COMISION GESTION CARTERA OF`, `IVA SOBRE COMISIONES` | `FEE` |
| `LIQUIDAC. INTERESES` | `INTEREST` |
| `CARGO RETENCION A CUENTA` | `TAX` |
| `ABONO PROMOCION` | `CREDIT` (subtype `BONUS`) |
| `TRANSFERENCIA SEPA`, `TRANSFERENCIA INMEDIATA`, `ABONO POR TRASPASO`, `BIZUM RECIBIDO` | `DEPOSIT` |
| `CARGO POR TRASPASO`, `TRANSF INMEDIATA EMITIDA`, `BIZUM ENVIADO`, `COMPRA COMERCIO O/L` (card purchase) | `WITHDRAWAL` |
| `APERTURA` | Skipped (account-opening marker, zero amount) |

## Avoiding duplicates with other addons/accounts

If you move money into MyInvestor from another broker you also track in
Wealthfolio (e.g. Trade Republic via trade-republic-importer-addon's Transfer
Patterns), that money can get recorded twice: once as a `TRANSFER_IN` by the
source account's addon, and again here as a `DEPOSIT` from the matching
`TRANSFERENCIA SEPA`/`TRANSFERENCIA INMEDIATA` row — Wealthfolio's own
duplicate detection won't catch this, since `DEPOSIT` and `TRANSFER_IN` hash
to different idempotency keys. Before importing, this addon checks your
MyInvestor account for an existing `TRANSFER_IN` of the same amount within a
day of the transfer date; if one is found, the `DEPOSIT` is skipped and
listed in its own **Duplicates** tab for review, instead of double-counting
the money.

Import order between the two addons isn't controlled by either one, so this
only prevents *new* duplicates going forward — if a `DEPOSIT` was already
created by an earlier import that ran before the matching `TRANSFER_IN`
existed, there was nothing to catch it at the time. Every import re-scans the
full movimientos history, though, so once both activities exist, that's
detected too and flagged (with both activity ids) as a confirmed duplicate
for you to delete manually — the addon has no way to delete activities
itself.

## Fund switches (traspasos) are recorded as SELL + BUY

In Spain, switching directly from one fund to another is tax-deferred — no
capital gain is realized for tax purposes. An earlier version of this addon
modeled that literally, using `TRANSFER_OUT` (old fund) + `TRANSFER_IN` (new
fund) instead of `SELL`/`BUY`, specifically to avoid showing a phantom
realized gain. That turned out to have a worse problem: Wealthfolio always
adds a `TRANSFER_IN`'s value to the account's `net_contribution` ("invested")
figure, regardless of pairing — treating every switch fragment as if it were
fresh external money. Since a fund switch has many more incoming fragments
than outgoing ones (MyInvestor splits redemptions into several receiving
fragments), this inflated `net_contribution` by the cumulative embedded gain
of every switched fund — silently and by a material amount over time.

Grouping the legs with a shared transfer id doesn't safely fix this either: a
grouped `TRANSFER_IN` reattaches the paired `TRANSFER_OUT`'s cached lots
verbatim, which for a cross-asset switch (a genuinely different fund) would
give the new fund the *old* fund's quantity and cost basis instead of its
own.

`SELL`/`BUY` never touch `net_contribution` and need no pairing, so switches
are now recorded as an ordinary `SELL` (old fund) + `BUY` (new fund) at the
switch-day price. The trade-off: each switch now shows as a real (though
non-taxable-in-Spain) realized gain/loss in Wealthfolio's performance/tax
reports.

### Non-EUR fund switches

A traspaso never touches movimientos, so unlike `SUSCRIPCION`/`REEMBOLSO`
(which derive their `fxRate` from a matched cash amount — see "USD-denominated
funds" below) there's no cash movement to derive a conversion rate from for a
non-EUR-denominated switch. Before transforming, the addon collects every
unique (currency, settlement date) pair among non-EUR switches and looks up a
historical rate via Wealthfolio's `exchangeRates.getRatesForDates` API, keyed
by the fund's **settlement date**, not its order date — real accounts can
settle a switch up to a week after it's ordered, and EUR/USD can move enough
in that window to matter. When no rate can be found (API error, or no data
for that currency/date), the switch still imports, just at the native price
with no `fxRate` — and it's flagged in an **FX rate warnings** tab so you
know that leg wasn't reconciled against a real historical rate.

This doesn't make cash reconciliation exact for non-EUR switches, and can't:
a fetched market rate is still an approximation of Inversis' own internal
conversion for that specific trade, not a byte-perfect match.

## Two movimientos export shapes

Inversis has exposed at least two different versions of the cuenta corriente
export, both auto-detected and imported correctly:

- A 6-column shape whose fund-trade concept text includes the share count
  (e.g. `"...FUND EUR @ 0.504"`).
- A 7-column shape that usually omits it — though on at least one real
  multi-year account, some rows carried it and others didn't, varying row by
  row rather than being a fixed property of the account or export version.

For each `SUSCRIPCION`/`REEMBOLSO` fondos row, the addon first tries to match
it to a cash movement by exact share count. When that's not available (or
doesn't line up with anything), it falls back to matching by fund-name
similarity — scoring how many whole words the two exports' fund names have in
common, since the two screens don't always spell the same fund the same way
(confirmed real example: fondos' `"MSCI JAPAN INDEX P ACC EUR"` vs
movimientos' `"FIDELITY MSCI JAPAN INDEX P AC"` for the identical fund). A
match by either method reconciles the trade to the exact EUR cash debited,
deriving a EUR-precise unit price; a row with no confident match either way
still imports as `BUY`/`SELL`, just at MyInvestor's stated price instead
(same trade-off as the fondos-only case below).

## USD-denominated funds

MyInvestor settles even USD-denominated fund trades in EUR from the single
cuenta corriente — there's no separate USD cash account. This addon mirrors
that: a USD fund's `BUY`/`SELL` activity carries `currency: "USD"` (the
fund's real quantity/price) plus an explicit `fxRate`, computed from the
actual EUR amount debited in the movimientos file, so Wealthfolio's cash
balance settles exactly in EUR.

For EUR-denominated funds, Wealthfolio ignores `fxRate` entirely (it only
applies when the activity's currency differs from the account's), so instead
the recorded unit price is derived from the real EUR amount debited divided
by the quantity — quantity stays exactly correct, and the account's cash
balance reconciles to the cent instead of drifting from MyInvestor's own
NAV-rounded "Precio Neto".

## Cartera Indexada

MyInvestor's separate robo-advisor "Cartera Indexada" product has no
fund-level detail in either export. Its cash footprint (`ABONO POR TRASPASO`,
`CARGO POR TRASPASO`, `COMISION GESTION CARTERA OF`) is imported as plain
cash movements (`DEPOSIT`/`WITHDRAWAL`/`FEE`) — it is **not** tracked as a
holding/position.

## Importing with only one file

- **Only movimientos**: fee/interest/deposit/tax rows import fine.
  `SUSCRIPCION IIC`/`REEMBOLSO IIC` rows have no fund detail (ISIN/quantity)
  and are skipped, listed under "Unsupported" for review.
- **Only fondos**: fund switches import fine (they never needed cash detail).
  Plain `SUSCRIPCION`/`REEMBOLSO` rows still import as `BUY`/`SELL`, but
  without a verified EUR cash tie-out (no `fxRate`, native-currency booking).

## Notes

- Both exports are HTML tables saved as `.xls`, encoded ISO-8859-1 — read
  directly, not converted to CSV first.
- Settings (account selection, security mappings) are stored securely in
  Wealthfolio's secrets store and pre-filled on every import.
