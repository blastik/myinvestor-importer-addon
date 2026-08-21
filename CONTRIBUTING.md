# Contributing

Thanks for considering a contribution! A few things that make review faster:

## Adding support for a new transaction type

If your change teaches `transform.ts`/`parseFiles.ts` to handle a new movimientos `tipo` or fondos operation, please also add anonymized sample rows for it to the fixtures:

- `src/__fixtures__/sample-fondos.xls` / `sample-movimientos.xls`
- exercised end-to-end by `src/fixtures.test.ts`

Fabricate the ISINs/amounts/concepts (no personal data), but keep the real encoding/HTML quirks of an actual export — see the existing fixture files for the shape. This keeps the end-to-end suite in sync with what the addon actually supports, instead of relying on unit tests alone.

## Versioning

Changes touching `src/`, `manifest.json` permissions/metadata, or transaction-mapping behavior should bump the version in both `manifest.json` and `package.json`, with a matching `CHANGELOG.md` entry — the release workflow only cuts a GitHub release when `manifest.json`'s version has no matching git tag yet.

## Running things locally

```bash
pnpm install
pnpm test:watch
pnpm type-check
pnpm build
```
