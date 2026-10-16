# AGENTS.md -- farrier-kit

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
  index.ts        barrel export (browser-safe; never re-exports node/)
  node/index.ts   NODE-ONLY: createPinnedFetch, DNS-pinned fetch (rebinding-safe)
  test-fixtures.ts  test-only invoice synthesis
  *.test.ts       co-located unit tests
vectors/
  *.json          language-neutral conformance vectors (the port contract)
  vectors.test.ts asserts the TS impl reproduces every vector
scripts/
  gen-vectors.mjs regenerates vectors from INDEPENDENT oracles
dist/             dual ESM + CJS via tsup, with .d.ts
```

Subpath exports: `.`, `/bolt11`, `/preimage`, `/lnurl`, `/http`, `/node`,
`/package.json`.

`src/node/` is the one Node-only corner. It may use `node:` builtins, so the
no-node-imports gate excludes it (`--exclude-dir=node`) and the root barrel must
never re-export from it. It is out of the conformance-vector contract (it is
server I/O, not a pure function); a native port implements its own pinning
against the same IP policy. `createPinnedFetch` closes the DNS-rebinding window
by being the connection, not a check before one: it resolves once, rejects any
private answer, and pins the socket to the approved address while keeping SNI,
cert validation and Host on the hostname.

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
   This is load-bearing: do not weaken the SSRF guard in `lnurl.ts` or the
   amount/network gate in `verifyInvoiceCommitment` without an adversarial review
   and a regression test. The library was security-audited.
6. **Every verifiable surface gets conformance vectors**, anchored on independent
   oracles (`node:crypto`, `light-bolt11-decoder`), never on farrier-kit itself.
   Regenerate with `node scripts/gen-vectors.mjs`, never by hand; CI fails on
   drift (`git diff --exit-code vectors/*.json`).

## Commands

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies |
| `npm run build` | Compile dual ESM + CJS via tsup |
| `npm test` | Run 144 tests (unit + conformance) |
| `npm run test:vectors` | Run the frozen-vector gate on its own (anvil calls this) |
| `npm run typecheck` | Type-check without emitting |
| `npm run check:no-node-imports` | Grep-gate: no `node:` imports outside `src/node/` |
| `npm run check:browser-bundle` | esbuild-bundle `dist/index.js` for a browser target |
| `node scripts/gen-vectors.mjs` | Regenerate conformance vectors from independent oracles |

Full local gate before pushing:

```sh
npm run typecheck && npm run check:no-node-imports && npm test && npm run build && npm run check:browser-bundle
node scripts/gen-vectors.mjs && git diff --exit-code vectors/*.json
```

## Testing and gates

Security: audited (three reviewers + a Codex cross-check). Do NOT weaken the
SSRF guard (`isPrivateIpLiteral`, `assertResolvableUrl`) or
`verifyInvoiceCommitment` without a fresh adversarial review and a regression
test. The guard classifies IP literals only; a hostname resolving inward needs
`fetchImpl: createPinnedFetch()` from `farrier-kit/node`. `urlGuard` is only an
extra check and cannot close DNS rebinding.

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
- **No em dashes** anywhere: docs, code comments, commit messages. Plain human
  voice, not balanced AI cadence.
- Commit style: `type: description`, lowercase imperative. No `Co-Authored-By`.
- Commit identity for this repo: `TheCryptoDonkey` (a forgesworn repo).

## Non-goals (the moat)

farrier-kit will **never** ship a payment sender, WebLN, boostagram, L402, BIP21,
fiat-in-core, NWC, or general Nostr cryptography. If an app needs focused NIP-47
wallet communication, it depends on `@forgesworn/nwc-kit` and uses farrier-kit
to verify the invoice and settlement preimage. Staying the small verification
layer is the point.

Positioning: farrier-kit is the only JS/TS library that SSRF-guards LNURL
resolution and gates the resolved invoice on all four of amount, network, expiry,
and description-hash. Do not chase wallet-toolkit breadth. See the README
comparison and `ROADMAP.md`.

## Common pitfalls

- Adding a heavy dependency (`nostr-tools`, `ln-service`) to `src/` breaks the
  zero-dependency, browser-safe contract.
- Hand-editing `vectors/*.json` instead of regenerating them from independent
  oracles: CI's `git diff --exit-code` catches this.
- Re-exporting anything from `src/node/` in the root barrel (`index.ts`) breaks
  the browser build.
