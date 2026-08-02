# farrier-kit roadmap

farrier-kit is the verification layer for Lightning: a small, audited, portable
core for reading and verifying payment data. It is not a wallet and not a node
client. This roadmap is about doing that one job better, not spreading into wallet
territory.

## Where it sits

Most Lightning JS libraries either just decode invoices or are full wallet
toolkits. farrier-kit takes the narrow, security-critical slice they leave open:
safely resolving a Lightning Address and proving a payment settled, with the same
guarantees in the browser, in Node, and, through
[conformance vectors](./CONFORMANCE.md), on native mobile. We are not trying to
win on breadth. We win on correctness, safe defaults, and portability. If you need
to send or zap, use a wallet toolkit. farrier-kit is the layer one of those can
sit on.

## Shipped, v1.0 core

| Module | Status |
|--------|--------|
| `/bolt11`, BOLT-11 decode (amount, hash, network, expiry, description) | done |
| `/preimage`, `payment_hash = SHA-256(preimage)`, constant-time verify | done |
| `/lnurl`, LUD-06/16 resolve, LUD-21 verify, SSRF guard, four-way invoice gate | done |
| `/http`, timeout and size-capped, redirect-safe JSON fetch | done |
| Independent security review (three reviewers plus Codex) | done |
| Language-neutral conformance vectors and porting guide | done |
| `/node`, DNS-pinned fetch for untrusted LNURL resolution (v1.1, rebinding-safe) | done |

## Next

### 1. Kotlin port checked against the vectors, and the priority

A native Kotlin build of the pure surface (`bolt11`, `preimage`, SSRF
classification, Lightning Address parsing) that passes
[`vectors/*.json`](./vectors). No JS-only competitor can follow this. It makes
farrier-kit the way a native Android or GrapheneOS app verifies payments the same
as web, down to the byte. It feeds the mobile clients on the
[TROTT](https://github.com/TheCryptoDonkey/trott) roadmap.

### 2. `/nwc`, NIP-47 Nostr Wallet Connect

A NIP-47 client with two transport patterns, one-shot for server payouts and a
persistent session for the browser, plus a wallet-service harness, which the
ecosystem currently lacks. All on `@noble`, with the official NIP-44 vectors in CI
and its own conformance vectors. This is the one piece of wallet-toolkit territory
that stays true to verify-and-settle work rather than turning us into a wallet.

### 3. `/nostr-crypto`

NIP-04 and NIP-44 v2 on `@noble`, checked against the official reference vectors.
It is the crypto engine under `/nwc`, exported for reuse, so nobody has to pull a
whole Nostr library just for wallet-connect.

### 4. `/fiat` and `/handles`

- `/fiat`: a BTC price oracle with an ISO-4217 minor-unit table and formatting,
  injectable fetch, and a TTL cache.
- `/handles`: Lightning Address and MSISDN validation and canonicalisation, with
  PII classification for phone-derived addresses.

## What will not change

- An `@noble`-only runtime core, with no `node:` imports, so the browser and Node
  run the same code. CI enforces it. The single exception is the optional
  `/node` entry, which is Node-only by design, gated out of the browser bundle,
  and never reachable from the root.
- Safe by default. The strict checks are on unless you turn them off.
- Every verifiable surface gets conformance vectors. New modules ship with their
  own locked-in, independently-anchored vectors so ports stay in step.
- We will not ship a payment sender, WebLN, boostagram, L402, BIP21, or
  fiat-in-core. If an app needs to send, it depends on a wallet toolkit and uses
  farrier-kit to verify.

## Versioning

Semantic versioning through [automated releases](./RELEASING.md). New modules are
additive and land as minor bumps, so a pinned `^1` consumer never breaks. A
breaking change, if one is ever needed, is a major bump.

Issues and ideas: [GitHub Issues](https://github.com/forgesworn/farrier-kit/issues).
