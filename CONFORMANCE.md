# Conformance vectors — porting farrier-kit to another language

farrier-kit ships **language-neutral test vectors** in [`vectors/`](./vectors) so
the pure, deterministic parts (BOLT-11 decode, preimage/hash, Lightning Address
parsing, SSRF classification, description-hash) can be re-implemented in Kotlin,
Swift, Rust, Go, or anything else and validated **byte-for-byte** against the
same frozen contract the TypeScript reference passes.

This exists because farrier-kit is the settlement-verification primitive under
[DonkeyRide](https://github.com/TheCryptoDonkey/DonkeyRide) (TROTT), and the
roadmap includes native Android / GrapheneOS clients. A Kotlin port that passes
these vectors verifies payments identically to the browser and Node builds — no
"it decoded slightly differently on mobile" class of bug.

## Files

| File | Covers | Pure? |
|------|--------|-------|
| [`vectors/bolt11.json`](./vectors/bolt11.json) | BOLT-11 invoice decode: network, amount, payment hash, description, expiry; and rejects | yes |
| [`vectors/preimage.json`](./vectors/preimage.json) | `payment_hash = SHA-256(preimage)`, and verify match/mismatch | yes |
| [`vectors/lightning-address.json`](./vectors/lightning-address.json) | LUD-16 address parse + canonicalisation + `.well-known` URL | yes |
| [`vectors/ssrf.json`](./vectors/ssrf.json) | private/reserved IP-literal classification (IPv4 + normalised IPv6) | yes |
| [`vectors/description-hash.json`](./vectors/description-hash.json) | `SHA-256(utf8(...))` for LUD-06 metadata and NIP-57 zap requests | yes |

The network-touching parts (`resolveLnurlPay`, `verifyLud21`, `fetchJson`) are
**not** frozen as vectors — they depend on live HTTP — but their pure building
blocks above are, and the behaviour they must implement is specified in the
[README](./README.md) and the source doc-comments.

## The two tiers

Each bolt11 vector carries a `tier`:

- **Tier 1 — MUST.** Universal correctness every conformant decoder reproduces
  (the real BOLT-11 spec vector, amount multipliers, payment-hash extraction,
  network prefixes, missing-hash / bad-checksum rejection). A port that fails a
  Tier-1 vector is wrong.
- **Tier 2 — SHOULD.** farrier-kit's defensive **policy** choices, flagged with
  a `policy` field (`reject-ambiguous-amount`, `reject-over-supply`,
  `reject-oversized-numeric-tag`). A port SHOULD match these for security
  parity; a port MAY be more lenient, but then it forfeits the hardening farrier
  ships. The SSRF table is Tier-2 security parity.

## Format notes for port authors

- **Amounts are decimal strings.** `amountMsats` is `"250000000"` or `null`, not
  a JSON number — invoice amounts can exceed 2⁵³. Parse as a big integer.
- **`syntheticUnsigned: true`** means the invoice carries a zero signature (it
  was synthesised to exercise a data-section case). If your decoder verifies the
  signature, disable that when testing these vectors, or test only the vectors
  where `syntheticUnsigned` is false (the real spec vector). Decoding the data
  section does not require signature verification.
- **SSRF hosts are already URL-normalised** — exactly what a URL parser's
  `hostname` yields. Your port must normalise first (decimal/octal/hex IPv4 and
  compressed IPv6 collapse to canonical forms) *before* classifying, the same
  way the WHATWG URL parser does. The table then tests the canonical host.
- **Lightning Address**: lowercase both the name and the domain; reject
  `localhost`, `.local`, and any host without a public TLD.
- **description_hash**: `SHA-256` over the **UTF-8 bytes** of the input string.

## Running the vectors

TypeScript (the reference) runs them in [`vectors/vectors.test.ts`](./vectors/vectors.test.ts):

```bash
npm test              # includes the conformance suite
node scripts/gen-vectors.mjs   # regenerate from the independent oracles
```

The generator anchors every expected value on an **independent** source —
`node:crypto` for hashes, [`light-bolt11-decoder`](https://www.npmjs.com/package/light-bolt11-decoder)
for invoices — never on farrier-kit itself, so the vectors are a genuine
external contract rather than a snapshot of one implementation. CI regenerates
and `git diff --exit-code`s them, so a hand-edited vector fails the build.

## A minimal Kotlin harness (sketch)

```kotlin
// Load vectors/bolt11.json, assert your decoder matches each `decoded` block
// (skip signature verification for syntheticUnsigned entries) and rejects each
// `errors` entry. Same shape for the other four files.
data class Decoded(val network: String, val amountMsats: String?, val paymentHashHex: String, val expirySeconds: Long, val timestamp: Long)

for (v in bolt11.valid) {
  val d = Bolt11.decode(v.invoice, verifySignature = !v.syntheticUnsigned)
  assertEquals(v.decoded.network, d.network)
  assertEquals(v.decoded.amountMsats, d.amountMsats?.toString())
  assertEquals(v.decoded.paymentHashHex, d.paymentHashHex)
}
for (v in bolt11.errors) assertFails { Bolt11.decode(v.invoice) }
```

When you ship a port, add its results here so the ecosystem knows what is
verified against the contract.
