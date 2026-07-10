# MyInvestor Importer

A Wealthfolio addon that imports MyInvestor (Inversis) exports into your portfolio.

## Overview

Getting the full picture requires **two exports** from inversis.com, because
neither one alone has everything:

- **Movimientos** (`Cuenta > Corriente > Operaciones y consultas > Movimientos`) —
  the EUR cash ledger: deposits, fees, interest, and the EUR cash side of
  every real fund buy/sell.
- **Consulta de operaciones** (`Inversiones > Fondos > Operaciones y consultas > Consulta de operaciones`) —
  fund-level detail (ISIN, quantity, native-currency price) for every fund
  movement, including tax-free fund switches (*traspasos*) that never touch
  cash and only appear here.

Both exports are HTML tables saved with an `.xls` extension — the addon reads
them directly, no conversion needed.

## Setup

1. Install the addon:
   - Download the `myinvestor-importer-addon.zip` asset from the
     [latest release](https://github.com/blastik/myinvestor-importer-addon/releases/latest)
   - In Wealthfolio, go to **Settings → Add-ons**, click **Install from File**, and
     select the downloaded zip
2. Go to **MyInvestor → Settings**
3. Select your **MyInvestor account**

## Importing

1. Export both files from inversis.com (see above)
2. Go to **MyInvestor → Import**
3. Drop or select both files (any order — they're auto-detected)
4. Review the parsed activities — duplicates are detected automatically
5. Map any unrecognised funds to their correct ticker (Security Mapping step)
6. Click **Import**

You can import with just one file if you don't have the other, but you'll get
a smaller/less accurate picture — see below.

## Supported Transaction Types

| Source rows | Wealthfolio activity |
| --- | --- |
| `SUSCRIPCION` (fondos) + `SUSCRIPCION IIC` (movimientos), joined by settlement date + share count | `BUY` |
| `REEMBOLSO` (fondos) + `REEMBOLSO IIC` (movimientos) | `SELL` |
| `SUSCR.POR TRASPASO I` / `ALTA IIC SWITCH` (fondos only — no cash impact) | `BUY` at switch-day price |
| `REEMB.POR TRASPASO I` / `BAJA IIC SWITCH` (fondos only — no cash impact) | `SELL` at switch-day price |
| `COMISION CUSTODIA MYINVESTOR`, `COMISION GESTION CARTERA OF`, `IVA SOBRE COMISIONES` | `FEE` |
| `LIQUIDAC. INTERESES` | `INTEREST` |
| `CARGO RETENCION A CUENTA` | `TAX` |
| `ABONO PROMOCION` | `CREDIT` (subtype `BONUS`) |
| `TRANSFERENCIA SEPA`, `TRANSFERENCIA INMEDIATA`, `ABONO POR TRASPASO` | `DEPOSIT` |
| `CARGO POR TRASPASO` | `WITHDRAWAL` |
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
day of the transfer date; if one is found, the `DEPOSIT` is skipped (listed
under "Unsupported" for review) instead of double-counting the money.

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
