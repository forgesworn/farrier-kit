# Changelog

All notable changes to farrier-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-08-09

### Fixed

- `isPrivateIpLiteral` no longer fails open on scope-suffixed IPv6 literals:
  a zone ID (`fe80::1%lo0`, as returned by mDNS, /etc/hosts or a custom
  `createPinnedFetch` resolve seam) is stripped before classification, and an
  unparseable string that still looks like an IPv6 literal now classifies as
  private rather than public.
- `createPinnedFetch` refuses plaintext `http:` by default. The pin proves you
  reached the address you resolved, which means nothing on a cleartext channel.
  Pass the new `allowHttp` option for local development only.
- `verifyInvoiceCommitment` validates `expectedMsats` before the decode
  attempt, so the `requireDecodable: false` deferral path refuses NaN,
  fractional and negative amounts instead of reporting `ok: true`.

## [1.1.0] - 2026-08-02

### Added

- `farrier-kit/node`: a Node-only, DNS-pinned `fetch` for resolving untrusted
  LNURL and Lightning Address hosts on a server. `createPinnedFetch` returns a
  `fetchImpl` for `resolveLnurlPay`, `verifyLud21` and `createCapabilityProbe`.
  It resolves the hostname once, rejects the request if any answer is private,
  loopback, link-local, reserved, documentation-only or multicast (IPv4 and
  IPv6), and pins the socket to the approved address by overriding its DNS
  lookup, so there is no second resolution for a rebinding race to win. The TLS
  SNI, certificate check and Host header stay on the original hostname, and it
  never follows redirects. This closes the DNS-rebinding window a check-then-
  fetch `urlGuard` cannot. Browser and other entries are unchanged.

### Notes

- The `/node` entry is server-side I/O, not part of the language-neutral vector
  contract; native ports implement their own pinning against the same IP policy.

## [1.0.1] - 2026-08-02

First release published through forgesworn/anvil (OIDC trusted publishing, SLSA
provenance, reproducible-build attestation).

### Added

- `./package.json` is now an exported subpath, so tooling and
  `require('farrier-kit/package.json')` resolve.

### Changed

- CI actions pinned to commit SHAs, and anvil's action-pin audit runs strict.

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

[1.1.0]: https://github.com/forgesworn/farrier-kit/releases/tag/v1.1.0
[1.0.1]: https://github.com/forgesworn/farrier-kit/releases/tag/v1.0.1
[1.0.0]: https://github.com/forgesworn/farrier-kit/releases/tag/v1.0.0
