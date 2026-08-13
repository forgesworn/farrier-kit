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

### Kotlin port checked against the vectors

A native Kotlin build of the pure surface (`bolt11`, `preimage`, SSRF
classification, Lightning Address parsing) that passes
[`vectors/*.json`](./vectors). No JS-only competitor can follow this. It makes
farrier-kit the way a native Android or GrapheneOS app verifies payments the same
as web, down to the byte. It feeds the mobile clients on the
[TROTT](https://github.com/TheCryptoDonkey/trott) roadmap. After that, additions
must strengthen the same read-and-verify job and arrive with independently
anchored vectors. Wallet communication is deliberately separate in
[`@forgesworn/nwc-kit`](https://github.com/forgesworn/nwc-kit).

## What will not change

- An `@noble`-only runtime core, with no `node:` imports, so the browser and Node
  run the same code. CI enforces it. The single exception is the optional
  `/node` entry, which is Node-only by design, gated out of the browser bundle,
  and never reachable from the root.
- Safe by default. The strict checks are on unless you turn them off.
- Every verifiable surface gets conformance vectors. New modules ship with their
  own locked-in, independently-anchored vectors so ports stay in step.
- We will not ship a payment sender, WebLN, boostagram, L402, BIP21, NWC,
  general Nostr cryptography, fiat pricing, or unrelated handle formats. If an
  app needs to send, it depends on a focused wallet client and uses farrier-kit
  to verify.

## Versioning

Semantic versioning through [automated releases](./RELEASING.md). New modules are
additive and land as minor bumps, so a pinned `^1` consumer never breaks. A
breaking change, if one is ever needed, is a major bump.

Issues and ideas: [GitHub Issues](https://github.com/forgesworn/farrier-kit/issues).
