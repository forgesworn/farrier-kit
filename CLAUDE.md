# CLAUDE.md -- farrier-kit

## What this is

Lightning payment **verification primitives** for JS/TS: decode a BOLT-11
invoice, resolve a Lightning Address to an invoice for an exact amount, and prove
a payment settled. Browser and Node from one codebase, `@noble/hashes` as the
only runtime dependency. It is NOT a wallet and NOT a node client. It holds no
keys and moves no money. It is the read-and-verify layer that sits before
payment, and the settlement-verification layer under DonkeyRide (TROTT).

## Architecture

```
src/
  bolt11.ts       BOLT-11 decode + verifyInvoiceCommitment (amount/network/hash gate)
  preimage.ts     payment_hash = SHA-256(preimage), constant-time verify
  lnurl.ts        LUD-06/16 resolve, LUD-21 verify, SSRF guard, capability probe
  http.ts         fetchJson: timeout + response-size cap + safe redirect default
  bech32.ts       internal BIP-173 (not exported)
  index.ts        barrel export
  test-fixtures.ts  test-only invoice synthesis
  *.test.ts       co-located unit tests
vectors/
  *.json          language-neutral conformance vectors (the port contract)
  vectors.test.ts asserts the TS impl reproduces every vector
scripts/
  gen-vectors.mjs regenerates vectors from INDEPENDENT oracles
dist/             dual ESM + CJS via tsup, with .d.ts
```

Subpath exports: `.`, `/bolt11`, `/preimage`, `/lnurl`, `/http`, `/package.json`.

## Design constraints (load-bearing, CI-enforced)

1. **No `node:` imports in `src/`** (test files and `scripts/` are exempt). CI
   greps for them (`npm run check:no-node-imports`) and bundles the output with
   `esbuild --platform=browser` (`npm run check:browser-bundle`). `@noble/hashes`
   is the only runtime dependency. Do not add `nostr-tools`, `ln-service`, or any
   heavy dep to the core.
2. **Dual ESM + CJS** via tsup, Node >= 18. `import` or `require` must both work.
3. **Injectable I/O.** `fetch` is a `fetchImpl` parameter, never ambient.
4. **Amounts.** Millisatoshis are `bigint`. `amountSats` is set only when the
   amount divides exactly. Flooring is the named `msatsToSatsFloor`, never
   implicit. Never assume a currency.
5. **Safe by default.** The SSRF guard and the four-way invoice gate
   (amount/network/expiry/description-hash) are on unless a caller turns them off.
6. **Every verifiable surface gets conformance vectors**, anchored on independent
   oracles (`node:crypto`, `light-bolt11-decoder`), never on farrier-kit itself.
   CI regenerates them and `git diff --exit-code`s, so a hand-edited vector fails.

## Testing and gates

- `npm test` runs 144 tests (unit + conformance). `npm run test:vectors` runs the
  frozen-vector gate on its own (anvil calls this).
- Full local gate before pushing: `npm run typecheck && npm run check:no-node-imports && npm test && npm run build && npm run check:browser-bundle`, plus `node scripts/gen-vectors.mjs && git diff --exit-code vectors/*.json`.
- Security: audited (three reviewers + a Codex cross-check). Do NOT weaken the
  SSRF guard (`isPrivateIpLiteral`, `assertResolvableUrl`) or `verifyInvoiceCommitment`
  without a fresh adversarial review and a regression test. The guard classifies
  IP literals only; a hostname resolving inward needs the consumer's `urlGuard`.

## Releasing (via forgesworn/anvil)

Versioning is manual and you own it. Automated publishing runs through
[forgesworn/anvil](https://github.com/forgesworn/anvil): OIDC trusted publishing
(no `NPM_TOKEN`), SLSA provenance, secret scan, exports check, the frozen-vector
gate, and a two-runner reproducible-build attestation. Full guide in
[RELEASING.md](RELEASING.md).

A release is three steps:

1. Bump `version` in `package.json`.
2. Add a `## [x.y.z]` section to `CHANGELOG.md` (anvil puts it in the release body).
3. Commit, push, then `gh release create vX.Y.Z --notes-from-tag`.

`release.yml` fires on `release: published`, verifies the tag matches the
package version, and publishes. Both anvil gates run strict: `strict-action-pins`
(so `ci.yml` actions must stay SHA-pinned) and `reproducibility-mode` (the two
builds must be byte-identical). Trusted publishing is already configured on
npmjs.com (repo `forgesworn/farrier-kit`, workflow `release.yml`, environment
`npm-publish`).

Hard-won gotchas:

- **A brand-new package name needs one manual bootstrap publish** before OIDC
  trusted publishing works, because npm's trusted-publisher flow requires the
  package to already exist. That was done once for farrier-kit; never needed again.
- **`npm publish` uses the current directory's `package.json`.** A stray publish
  from the wrong cwd publishes that project. The sibling DonkeyRide repo is
  `"private": true` as a guard after one near-miss. Always confirm the package
  name in the pack output before authorising a publish.
- **Do not create a GitHub Release for a version already on npm.** It retriggers
  anvil and the publish fails on the existing version.

## Conventions

- **British English** everywhere (colour, normalise, licence, behaviour).
- **No em dashes** anywhere: docs, code comments, commit messages. Write in a
  plain human voice, not balanced AI cadence.
- Commit style: `type: description`, lowercase imperative. No `Co-Authored-By`.
- Commit identity for this repo: `TheCryptoDonkey` (a forgesworn repo).

## Non-goals (the moat)

farrier-kit will **never** ship a payment sender, WebLN, boostagram, L402, BIP21,
fiat-in-core, or NWC-as-a-wallet. If an app needs to send or zap, it depends on a
wallet toolkit (Alby's `@getalby/lightning-tools`) and uses farrier-kit to
verify. Staying the small verification layer is the point.

Positioning: farrier-kit is the only JS/TS library that SSRF-guards LNURL
resolution and gates the resolved invoice on all four of amount, network, expiry,
and description-hash. Do not chase Alby's breadth. See the README comparison and
`ROADMAP.md` (Kotlin port next, then `/nwc`, `/nostr-crypto`, `/fiat`, `/handles`,
all additive minors).
