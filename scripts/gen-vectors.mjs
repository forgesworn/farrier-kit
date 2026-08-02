// Regenerate the language-neutral conformance vectors in vectors/*.json.
//
//   node scripts/gen-vectors.mjs
//
// Expected values are anchored on INDEPENDENT references, never on farrier-kit
// itself, so the vectors are a genuine external contract:
//   - payment hashes:   node:crypto sha256
//   - bolt11 decode:    light-bolt11-decoder (a separate implementation)
// Invoice strings are synthesised with an inlined bech32 encoder (BIP-173).
// Synthetic invoices carry a zero signature and are flagged syntheticUnsigned:
// a port whose decoder verifies signatures must disable that for those vectors.
// The one real, signed vector is the BOLT-11 spec's donation invoice.
//
// vectors/vectors.test.ts asserts farrier-kit reproduces every vector, so CI
// fails the moment the implementation drifts from the frozen contract.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decode as lightDecode } from 'light-bolt11-decoder'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors')

// ---- inlined bech32 (BIP-173) for synthesising invoice strings -------------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const polymod = (v) => {
  let chk = 1
  for (const x of v) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ x
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]
  }
  return chk
}
const hrpExpand = (hrp) => {
  const out = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}
const bech32Encode = (hrp, data) => {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])
  const mod = polymod(values) ^ 1
  const checksum = []
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31)
  let out = `${hrp}1`
  for (const d of data.concat(checksum)) out += CHARSET.charAt(d)
  return out
}
const convertBits = (data, from, to, pad) => {
  let acc = 0
  let bits = 0
  const out = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv)
  return out
}
const hexToWords52 = (hex) => {
  const bytes = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return convertBits(bytes, 8, 5, true)
}
const numWords = (n) => {
  const out = []
  let v = n
  do {
    out.unshift(v % 32)
    v = Math.floor(v / 32)
  } while (v > 0)
  return out
}
const utf8Words = (s) => convertBits([...Buffer.from(s, 'utf8')], 8, 5, true)
// tags: [type, ...words]; builds a checksum-valid, zero-signature invoice.
const buildInvoice = (hrp, tags, timestamp = 1700000000) => {
  const data = []
  for (let i = 6; i >= 0; i--) data.push((timestamp >> (5 * i)) & 31)
  for (const [type, words] of tags) {
    data.push(type, Math.floor(words.length / 32), words.length % 32, ...words)
  }
  data.push(...Array(104).fill(0))
  return bech32Encode(hrp, data)
}

const sha256hex = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
const sha256utf8 = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

const HASH = 'a1'.repeat(32)
const P = [1, hexToWords52(HASH)]

// Decode a valid invoice with the independent oracle and shape the expected fields.
const oracle = (invoice) => {
  const secs = lightDecode(invoice).sections
  const get = (name) => secs.find((s) => s.name === name)?.value
  const amount = get('amount')
  return {
    network: get('coin_network')?.bech32 ?? bech32Network(invoice),
    amountMsats: amount === undefined ? null : String(amount),
    paymentHashHex: get('payment_hash') ?? null,
    description: get('description') ?? null,
    expirySeconds: get('expiry') ?? 3600,
    timestamp: get('timestamp'),
  }
}
const bech32Network = (inv) => inv.match(/^ln(bcrt|bc|tbs|tb|sb)/)[1]

// ---- bolt11 vectors --------------------------------------------------------
const SPEC_INVOICE =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmw' +
  'wd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz' +
  '9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'

const validInvoices = [
  { name: 'spec-vector-amountless-mainnet', invoice: SPEC_INVOICE, tier: 1, signed: true },
  { name: 'amount-2500u-mainnet', invoice: buildInvoice('lnbc2500u', [P]), tier: 1 },
  { name: 'amount-1m-mainnet', invoice: buildInvoice('lnbc1m', [P]), tier: 1 },
  { name: 'amount-10n-mainnet', invoice: buildInvoice('lnbc10n', [P]), tier: 1 },
  { name: 'amount-100p-mainnet', invoice: buildInvoice('lnbc100p', [P]), tier: 1 },
  { name: 'amount-whole-btc-mainnet', invoice: buildInvoice('lnbc2', [P]), tier: 1 },
  { name: 'leading-zeros-tolerated', invoice: buildInvoice('lnbc0100u', [P]), tier: 1 },
  { name: 'testnet', invoice: buildInvoice('lntb2500u', [P]), tier: 1 },
  { name: 'signet', invoice: buildInvoice('lntbs2500u', [P]), tier: 1 },
  { name: 'regtest', invoice: buildInvoice('lnbcrt2500u', [P]), tier: 1 },
  {
    name: 'with-description-and-expiry',
    invoice: buildInvoice('lnbc2500u', [P, [13, utf8Words('1 coffee')], [6, numWords(60)]]),
    tier: 1,
  },
]

const errorInvoices = [
  { name: 'ambiguous-hrp-trailing-digits', invoice: buildInvoice('lnbc100u200', [P]), tier: 2, policy: 'reject-ambiguous-amount' },
  { name: 'amount-over-21m-supply', invoice: buildInvoice(`lnbc${'9'.repeat(20)}`, [P]), tier: 2, policy: 'reject-over-supply' },
  { name: 'numeric-tag-overflow', invoice: buildInvoice('lnbc1u', [P, [6, Array(300).fill(31)]]), tier: 2, policy: 'reject-oversized-numeric-tag' },
  { name: 'no-payment-hash', invoice: buildInvoice('lnbc1u', [[13, utf8Words('x')]]), tier: 1, policy: 'reject-missing-payment-hash' },
  { name: 'not-bolt11', invoice: 'hello world', tier: 1, policy: 'reject-non-invoice' },
  { name: 'bad-checksum', invoice: SPEC_INVOICE.slice(0, -4) + 'qqqq', tier: 1, policy: 'reject-bad-checksum' },
]

const bolt11Vectors = {
  description: 'BOLT-11 invoice decoding. amountMsats is a decimal string (may exceed 2^53) or null when amountless. Expected values for valid invoices are computed with light-bolt11-decoder; error cases assert the decoder rejects. syntheticUnsigned invoices carry a zero signature, a signature-verifying decoder must disable verification to test them.',
  tiers: { 1: 'MUST, universal correctness every conformant decoder matches', 2: 'SHOULD, farrier-kit defensive policy; match for security parity' },
  valid: validInvoices.map((v) => ({
    name: v.name,
    tier: v.tier,
    syntheticUnsigned: !v.signed,
    invoice: v.invoice,
    decoded: oracle(v.invoice),
  })),
  errors: errorInvoices.map((v) => ({
    name: v.name,
    tier: v.tier,
    syntheticUnsigned: !/^lnbc1pvj/.test(v.invoice) && /^ln/.test(v.invoice),
    invoice: v.invoice,
    reject: true,
    policy: v.policy,
  })),
}

// ---- preimage vectors ------------------------------------------------------
const preimages = ['00'.repeat(32), 'ff'.repeat(32), 'a1'.repeat(32), '0123456789abcdef'.repeat(4)]
const preimageVectors = {
  description: 'payment_hash = SHA-256(preimage bytes). verify pairs assert a preimage matches (or not) a payment hash. Hashes computed with node:crypto.',
  hash: preimages.map((preimage) => ({ preimage, paymentHash: sha256hex(preimage) })),
  verify: [
    { preimage: 'a1'.repeat(32), paymentHash: sha256hex('a1'.repeat(32)), valid: true },
    { preimage: 'a1'.repeat(32), paymentHash: sha256hex('b2'.repeat(32)), valid: false },
    { preimage: 'A1'.repeat(32), paymentHash: sha256hex('a1'.repeat(32)).toUpperCase(), valid: true, note: 'case-insensitive' },
    { preimage: 'nothex', paymentHash: sha256hex('a1'.repeat(32)), valid: false, note: 'malformed preimage' },
    { preimage: 'a1'.repeat(31), paymentHash: sha256hex('a1'.repeat(32)), valid: false, note: 'wrong length' },
  ],
}

// ---- lightning address vectors ---------------------------------------------
const lightningAddressVectors = {
  description: 'Lightning Address (LUD-16) parse + canonicalisation. Both name and domain lowercase; a public domain required.',
  valid: [
    { input: 'alice@wallet.example.com', name: 'alice', domain: 'wallet.example.com' },
    { input: 'Alice@Wallet.Example.COM', name: 'alice', domain: 'wallet.example.com', note: 'lowercased' },
    { input: ' bob@w.example.net ', name: 'bob', domain: 'w.example.net', note: 'trimmed' },
    { input: '2547001122@bitcoin.co.ke', name: '2547001122', domain: 'bitcoin.co.ke', note: 'phone-derived (Tando)' },
  ],
  invalid: ['nope', 'a@b', 'a b@x.com', 'alice@localhost', 'alice@dev.local', ''],
  lnurlpUrl: [
    { name: 'alice', domain: 'wallet.example.com', url: 'https://wallet.example.com/.well-known/lnurlp/alice' },
    { name: 'a b', domain: 'x.co', url: 'https://x.co/.well-known/lnurlp/a%20b', note: 'name percent-encoded' },
  ],
}

// ---- SSRF classification vectors -------------------------------------------
// A security-critical decision table: is this URL-normalised host a private or
// reserved IP literal? Kotlin/Swift ports MUST reproduce this to keep parity.
const ssrfVectors = {
  description: 'isPrivateIpLiteral(host), host is already URL-normalised (what URL.hostname yields). true = private/reserved (block). Tier-2 security parity table.',
  private: [
    '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '0.0.0.0', '192.0.0.1', '198.18.0.1', '192.88.99.1',
    '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1',
    '2001::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::',
  ],
  public: ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2600:9000::1', '::ffff:8.8.8.8', '2002:808:808::'],
  note: 'A hostname that RESOLVES to a private IP is NOT covered here, that needs a DNS-resolving guard in the consuming app (see README).',
}

// ---- description-hash (LUD-06 / NIP-57) ------------------------------------
const descHashVectors = {
  description: 'The invoice description_hash (h tag) binds the invoice. LUD-06: sha256(metadata string). NIP-57 zap: sha256(the signed zap request). Computed with node:crypto.',
  vectors: [
    { kind: 'lud06-metadata', input: '[["text/plain","coffee"]]', descriptionHashHex: sha256utf8('[["text/plain","coffee"]]') },
    { kind: 'nip57-zap-request', input: '{"kind":9734,"tags":[],"content":""}', descriptionHashHex: sha256utf8('{"kind":9734,"tags":[],"content":""}') },
  ],
}

const write = (name, obj) => {
  writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2) + '\n')
  console.log('wrote vectors/' + name)
}
write('bolt11.json', bolt11Vectors)
write('preimage.json', preimageVectors)
write('lightning-address.json', lightningAddressVectors)
write('ssrf.json', ssrfVectors)
write('description-hash.json', descHashVectors)
