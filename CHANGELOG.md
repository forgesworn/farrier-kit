# Changelog

All notable changes to farrier-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-02

First release: the audited verification core.

### Added

- `farrier-kit/bolt11`: BOLT-11 invoice decoding (payment hash, amount as
  `bigint` millisatoshis, network, expiry, description), with a strict decoder
  that throws and null-returning helpers for expected-invalid input, plus
  `verifyInvoiceCommitment` that gates a payer on the payment hash, the amount,
  and the network.
- `farrier-kit/preimage`: `payment_hash = SHA-256(preimage)` generate, hash, and
  constant-time verify. API-compatible with escrow-kit.
- `farrier-kit/lnurl`: Lightning Address resolution (LUD-06/16), LUD-21 verify
  with a cryptographic preimage check, and capability probing with a bounded TTL
  cache. The fetch is SSRF-guarded (HTTPS-only, credential-free, private and
  reserved IP literals rejected across IPv4 and normalised IPv6, redirects
  refused, response size capped), and the resolved invoice is checked for amount,
  network, expiry, and description-hash before you trust it.
- `farrier-kit/http`: `fetchJson` with a hard timeout, a streamed response-size
  cap, and a redirect default of `manual`.
- Language-neutral conformance vectors in `vectors/*.json` with a porting guide
  in `CONFORMANCE.md`, so Kotlin, Swift, or Rust ports can be checked
  byte-for-byte against the same contract.

### Security

- Independent security review before release (three reviewers plus a Codex
  cross-check). Findings hardened with regression tests: the SSRF guard bypasses
  (normalised IPv6 forms, trailing-dot hosts, credentials), the missing amount
  and network gate on `verifyInvoiceCommitment`, a response-size cap bypass on
  node-fetch-style bodies, and a NIP-57 zap description-hash binding, along with
  a set of bolt11 parsing footguns.

[1.0.0]: https://github.com/forgesworn/farrier-kit/releases/tag/v1.0.0
