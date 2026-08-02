# farrier-kit

Lightning payment primitives that work anywhere. A farrier shoes working animals
for the road; this kit shoes your payment paths.

- **`farrier-kit/bolt11`** — BOLT-11 invoice decoding: payment hash, amount,
  description, expiry, network. Checksum-verified, no signature recovery, no
  heavyweight node library just to read two fields.
- **`farrier-kit/preimage`** — preimage ↔ payment_hash: generate, hash, verify
  (constant-time), explain.
- **`farrier-kit/lnurl`** — Lightning Address → invoice (LUD-06/16), LUD-21
  verify with preimage cross-check, capability probing with a TTL cache, and
  SSRF guarding (HTTPS-only, public hosts, private-IP rejection, manual
  redirects, injectable DNS-pinning hook).
- **`farrier-kit/http`** — `fetchJson` with a hard timeout, because some fetch
  implementations will happily hang forever.

Coming next (see roadmap below): `/nwc` (NIP-47 client + wallet service),
`/fiat`, `/handles`.

## Design rules

1. **Browser and Node from one codebase.** No `node:` imports anywhere in the
   library — CI greps for them and bundles the output with
   `esbuild --platform=browser` to prove it. Crypto is
   [@noble/hashes](https://github.com/paulmillr/noble-hashes), the only runtime
   dependency.
2. **Dual ESM + CJS.** `import` or `require`, Node ≥18, any bundler.
3. **Injectable I/O.** `fetch` is a parameter, not an ambient assumption.
4. **Explicit amounts.** Millisatoshis are `bigint`. `amountSats` is only set
   when the amount divides exactly; flooring is a separate, named operation
   (`msatsToSatsFloor`) so a sub-satoshi remainder can never vanish silently.
5. **Verified against independents.** The test suite cross-validates every
   invoice fixture against `light-bolt11-decoder` and the BOLT-11 spec vector,
   and the preimage hash against a second SHA-256 implementation.

## Usage

```js
import { decodeBolt11, verifyInvoiceCommitment } from 'farrier-kit/bolt11'

const inv = decodeBolt11('lnbc2500u1p...')
inv.paymentHashHex // '0001…0102'
inv.amountMsats    // 250000000n
inv.amountSats     // 250000 (null when not a whole satoshi)
inv.expirySeconds  // 60 (spec default 3600 when absent)

// Pre-payment check: does this invoice commit to the hash I was promised?
const check = verifyInvoiceCommitment({ bolt11, paymentHash: expectedHash })
if (!check.ok) throw new Error(check.reason)
```

```js
import { generatePreimage, computePaymentHash, verifyPreimage } from 'farrier-kit/preimage'

const preimage = generatePreimage()
const paymentHash = computePaymentHash(preimage)
// ... invoice settles, counterparty reveals the preimage ...
verifyPreimage(revealed, paymentHash) // constant-time true/false
```

```js
import { resolveLnurlPay, verifyLud21 } from 'farrier-kit/lnurl'

// Lightning Address -> bolt11 for an exact amount. The returned invoice has
// been decoded and its amount verified to equal the request; a mismatched or
// amountless invoice throws. LUD-12 comments truncate to commentAllowed;
// NIP-57 zap requests attach when the service supports them.
const paid = await resolveLnurlPay({ address: 'alice@wallet.example.com', amountSats: 21000 })
paid.bolt11         // hand to any wallet
paid.paymentHashHex // verify the revealed preimage against this
paid.verifyUrl      // LUD-21, when offered

// Later: LUD-21 settlement check. verified=true only when the returned
// preimage cryptographically matches — settled alone is the service's word.
const status = await verifyLud21({ verifyUrl: paid.verifyUrl, paymentHashHex: paid.paymentHashHex })
```

```js
import { fetchJson } from 'farrier-kit/http'

const body = await fetchJson('https://example.com/.well-known/lnurlp/alice', {
  timeoutMs: 5000,          // default 8000
  fetchImpl: myFetch,       // optional; defaults to globalThis.fetch
})
```

### Non-throwing variants

`decodeBolt11` throws a `Bolt11Error` with a machine-readable `code`
(`BAD_BECH32`, `MISSING_PAYMENT_HASH`, …). When "not an invoice" is an expected
input class, use `tryDecodeBolt11` (returns `null`), or the single-field
helpers `bolt11PaymentHash` / `bolt11AmountMsats`.

## Who uses it

The reference consumer is [DonkeyRide](https://github.com/TheCryptoDonkey/DonkeyRide),
the TROTT protocol reference operator, which uses it for non-custodial
settlement verification (LNURL-pay + preimage proof).

## Roadmap

| Module | Status |
|---|---|
| `/bolt11`, `/preimage`, `/http` | shipped |
| `/lnurl` — LUD-06/16 resolution, LUD-21 verify, capability probing | shipped |
| `/nwc` — NIP-47 client (both transport patterns) + wallet-service harness | planned |
| `/nostr-crypto` — NIP-04/NIP-44 v2 on @noble, official-vector CI | planned |
| `/fiat` — BTC price oracle, ISO-4217 minor units, formatting | planned |
| `/handles` — Lightning Address / MSISDN validation + PII classification | planned |

## Licence

MIT
