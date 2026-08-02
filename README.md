# farrier-kit

[![Nostr](https://img.shields.io/badge/Nostr-Zap%20me-purple)](https://primal.net/p/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

Lightning payment primitives that work anywhere. A farrier shoes working animals
for the road; this kit shoes your payment paths.

- **`farrier-kit/bolt11`** — BOLT-11 invoice decoding: payment hash, amount,
  description, expiry, network. Checksum-verified, no signature recovery, no
  heavyweight node library just to read two fields.
- **`farrier-kit/preimage`** — preimage ↔ payment_hash: generate, hash, verify
  (constant-time), explain.
- **`farrier-kit/lnurl`** — Lightning Address → invoice (LUD-06/16), LUD-21
  verify with preimage cross-check, capability probing with a bounded TTL
  cache, invoice amount/network/expiry/description-hash checks, and SSRF
  guarding for IP literals (HTTPS-only, credential-free, private/reserved IPv4
  **and normalised IPv6** rejection, manual redirects). See the SSRF note below
  for the one thing the built-in guard cannot do alone.
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

// Pre-payment check. The payment_hash ALONE is not enough — the payee picks the
// preimage, so they can mint a second invoice with the same hash and any amount.
// Pass expectedMsats (and rely on the default mainnet network) when money moves.
const check = verifyInvoiceCommitment({
  bolt11,
  paymentHash: expectedHash,
  expectedMsats: 250000000n,
})
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

## SSRF: what the guard does and does not do

`resolveLnurlPay` fetches from payee-controlled domains, so it is an SSRF
surface. The built-in guard rejects an HTTPS violation, credentials in the URL,
`localhost`/`.local`/`.internal` hosts (trailing dot included), and any **IP
literal** in a private or reserved range — IPv4, and IPv6 in every form the URL
parser normalises to (mapped `::ffff:*`, NAT64, 6to4, Teredo, link/site-local,
ULA, multicast).

What it **cannot** do in the core: stop a *hostname* that resolves to a private
address (an attacker A-record at `10.0.0.5`, or a DNS-rebinding TOCTOU).
Browsers cannot resolve DNS, so a safe default is impossible without a Node
dependency. **On a server that resolves untrusted addresses, pass `urlGuard`**:

```js
import { lookup } from 'node:dns/promises'
import { isPrivateIpLiteral, resolveLnurlPay } from 'farrier-kit/lnurl'

const pinToPublic = async (url) => {
  const { address } = await lookup(url.hostname)
  if (isPrivateIpLiteral(address)) throw new Error(`blocked: ${url.hostname} -> ${address}`)
}

await resolveLnurlPay({ address, amountSats, urlGuard: pinToPublic })
```

`urlGuard` runs after the built-in checks, on every fetched URL. For full
protection against rebinding, resolve once and connect to the pinned IP via a
custom `fetchImpl`/agent.

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

## Support

For issues and feature requests, see [GitHub Issues](https://github.com/forgesworn/farrier-kit/issues).

If you find farrier-kit useful, consider sending a tip:

- **Lightning:** `profusemeat89@walletofsatoshi.com`
- **Nostr zaps:** `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

## Licence

MIT
