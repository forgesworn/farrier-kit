# farrier-kit roadmap

farrier-kit is the **trust-minimised verification layer** for Lightning: the
small, audited, portable core an app reaches for to *read and verify* payment
data — not a wallet, not a node client. This roadmap is about deepening that one
job, not broadening into a wallet toolkit.

**Positioning.** Most Lightning JS libraries either only decode invoices or are
wallet/payment toolkits. farrier-kit deliberately owns the narrow,
security-critical slice they leave open: safely resolving a Lightning Address
and proving a payment settled, with the same guarantees in the browser, in Node,
and — via [conformance vectors](./CONFORMANCE.md) — on native mobile. We don't
compete on breadth; we compound on correctness, safety-by-default, and
portability. If you need to *send* or *zap*, use a wallet toolkit; farrier-kit is
the layer that can sit under one.

## Shipped — v1.0 core

| Module | Status |
|--------|--------|
| `/bolt11` — BOLT-11 decode (amount, hash, network, expiry, description) | ✅ |
| `/preimage` — `payment_hash = SHA-256(preimage)`, constant-time verify | ✅ |
| `/lnurl` — LUD-06/16 resolve, LUD-21 verify, SSRF guard, four-way invoice gate | ✅ |
| `/http` — timeout + size-capped, redirect-safe JSON fetch | ✅ |
| Independent security audit (3 reviewers + Codex) | ✅ |
| Language-neutral conformance vectors + porting guide | ✅ |

## Next

### 1. Kotlin port validated against the vectors — *the priority*
A native Kotlin implementation of the pure surface (`bolt11`, `preimage`, SSRF
classification, Lightning Address parsing) green against
[`vectors/*.json`](./vectors). This is the move no JS-only competitor can follow:
it makes farrier-kit the only way a native Android / GrapheneOS app verifies
payments **byte-for-byte identically to web**. Serves the mobile clients on the
[TROTT](https://github.com/TheCryptoDonkey/trott) roadmap directly.

### 2. `/nwc` — NIP-47 Nostr Wallet Connect, done our way
A NIP-47 **client** with two transport patterns (one-shot for server payouts, a
persistent session for the browser), **plus** a wallet-service harness — the
piece the ecosystem lacks — all on `@noble` only, with the official NIP-44
vectors pinned in CI and its own conformance vectors. The one slice of wallet-
toolkit territory that stays true to "verify/settle rigour" rather than
"become a wallet".

### 3. `/nostr-crypto`
NIP-04 and NIP-44 v2 on `@noble`, validated against the official reference
vectors — the crypto engine under `/nwc`, exported for reuse. Removes any need to
pull a full Nostr library for wallet-connect.

### 4. `/fiat` and `/handles`
- `/fiat` — a BTC price oracle with an ISO-4217 minor-unit table and formatting,
  injectable fetch, TTL cache.
- `/handles` — Lightning Address / MSISDN validation and canonicalisation, with
  PII classification for phone-derived addresses.

## Principles that won't change

- **@noble-only runtime core, no `node:` imports** — browser and Node from one
  codebase, CI-enforced.
- **Safe by default** — the strict checks are on unless you turn them off.
- **Every verifiable surface gets conformance vectors** — new modules ship with
  their locked-in, independently-anchored vectors so ports stay in lockstep.
- **We will never ship** a payment sender, WebLN, boostagram, L402, BIP21, or
  fiat-in-core. If an app needs to send, it depends on a wallet toolkit and uses
  farrier-kit to verify.

## Versioning

Semantic versioning via [automated releases](./RELEASING.md). New modules are
additive and land as **minor** bumps — a pinned `^1` consumer never breaks.
Breaking changes, if ever needed, are a major bump.

Issues and ideas: [GitHub Issues](https://github.com/forgesworn/farrier-kit/issues).
