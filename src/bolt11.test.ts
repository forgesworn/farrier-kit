import { decode as lightDecode } from 'light-bolt11-decoder'
import { describe, expect, it } from 'vitest'
import { bech32Encode, convertBits } from './bech32.js'
import {
  BOLT11_DEFAULT_EXPIRY_SECONDS,
  Bolt11Error,
  bolt11AmountMsats,
  bolt11PaymentHash,
  decodeBolt11,
  msatsToSatsFloor,
  tryDecodeBolt11,
  verifyInvoiceCommitment,
} from './bolt11.js'

// BOLT-11 spec vector ("Please make a donation of any amount using
// payment_hash 0001...0102 to me @03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad").
const SPEC_INVOICE =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmw' +
  'wd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz' +
  '9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102'

// Synthesise a checksum-valid invoice: timestamp, tagged fields, zero
// signature. Signatures are not verified by this decoder (nor by
// light-bolt11-decoder), so zeros keep fixtures deterministic.
interface TestTag {
  type: number
  words: number[]
}
function tag(type: number, words: number[]): TestTag {
  return { type, words }
}
function words52(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return convertBits(bytes, 8, 5, true)!
}
function utf8Words(text: string): number[] {
  return convertBits([...new TextEncoder().encode(text)], 8, 5, true)!
}
function numberWords(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    out.unshift(v % 32)
    v = Math.floor(v / 32)
  } while (v > 0)
  return out
}
function buildInvoice(hrp: string, tags: TestTag[], timestamp = 1_700_000_000): string {
  const data: number[] = []
  for (let i = 6; i >= 0; i--) data.push((timestamp >> (5 * i)) & 31)
  for (const t of tags) {
    data.push(t.type, Math.floor(t.words.length / 32), t.words.length % 32, ...t.words)
  }
  data.push(...Array(104).fill(0))
  return bech32Encode(hrp, data)
}

const HASH = 'a1'.repeat(32)
const P = tag(1, words52(HASH))

describe('decodeBolt11', () => {
  it('decodes the BOLT-11 spec vector', () => {
    const d = decodeBolt11(SPEC_INVOICE)
    expect(d.paymentHashHex).toBe(SPEC_HASH)
    expect(d.network).toBe('bc')
    expect(d.amountMsats).toBeNull()
    expect(d.amountSats).toBeNull()
    expect(d.timestamp).toBe(1496314658)
    expect(d.description).toBe('Please consider supporting this project')
    expect(d.expirySeconds).toBe(BOLT11_DEFAULT_EXPIRY_SECONDS)
    // Uppercase form is equally valid bech32.
    expect(decodeBolt11(SPEC_INVOICE.toUpperCase()).paymentHashHex).toBe(SPEC_HASH)
  })

  it('reads amount, expiry, description and secret from synthesised invoices', () => {
    const inv = buildInvoice('lnbc2500u', [
      P,
      tag(16, words52('b2'.repeat(32))),
      tag(13, utf8Words('1 cup coffee')),
      tag(6, numberWords(60)),
      tag(24, numberWords(144)),
    ])
    const d = decodeBolt11(inv)
    expect(d.network).toBe('bc')
    expect(d.amountMsats).toBe(250_000_000n)
    expect(d.amountSats).toBe(250_000)
    expect(d.paymentHashHex).toBe(HASH)
    expect(d.paymentSecretHex).toBe('b2'.repeat(32))
    expect(d.description).toBe('1 cup coffee')
    expect(d.expirySeconds).toBe(60)
    expect(d.minFinalCltvExpiry).toBe(144)
    expect(d.timestamp).toBe(1_700_000_000)
  })

  it('handles every network prefix', () => {
    for (const [hrp, network] of [
      ['lnbc1n', 'bc'],
      ['lntb1n', 'tb'],
      ['lntbs1n', 'tbs'],
      ['lnbcrt1n', 'bcrt'],
      ['lnsb1n', 'sb'],
    ] as const) {
      expect(decodeBolt11(buildInvoice(hrp, [P])).network).toBe(network)
    }
  })

  it('normalises all amount multipliers to msats', () => {
    expect(decodeBolt11(buildInvoice('lnbc21u', [P])).amountMsats).toBe(2_100_000n)
    expect(decodeBolt11(buildInvoice('lnbc21000n', [P])).amountMsats).toBe(2_100_000n)
    expect(decodeBolt11(buildInvoice('lnbc21000000p', [P])).amountMsats).toBe(2_100_000n)
    expect(decodeBolt11(buildInvoice('lnbc2m', [P])).amountMsats).toBe(200_000_000n)
    expect(decodeBolt11(buildInvoice('lnbc2', [P])).amountMsats).toBe(200_000_000_000n)
    // Sub-msat pico amounts are invalid per spec.
    expect(() => decodeBolt11(buildInvoice('lnbc21000001p', [P]))).toThrow(Bolt11Error)
  })

  it('never silently floors sub-satoshi amounts', () => {
    const d = decodeBolt11(buildInvoice('lnbc10n', [P])) // 1000 msat = 1 sat exactly
    expect(d.amountSats).toBe(1)
    const sub = decodeBolt11(buildInvoice('lnbc15n', [P])) // 1500 msat
    expect(sub.amountMsats).toBe(1500n)
    expect(sub.amountSats).toBeNull()
    expect(msatsToSatsFloor(sub.amountMsats!)).toBe(1)
  })

  it('rejects garbage with coded errors', () => {
    expect(() => decodeBolt11('not an invoice')).toThrow(/does not start/)
    expect(() => decodeBolt11(SPEC_INVOICE.slice(0, -4) + 'qqqq')).toThrow(/bech32/)
    expect(() => decodeBolt11(buildInvoice('lnbc21u', []))).toThrow(/no p tag/)
    expect(() => decodeBolt11('lnxx' + buildInvoice('lnbc21u', [P]).slice(4))).toThrow(Bolt11Error)
    // lnurl is bech32 with an ln-ish look but no invoice structure.
    expect(
      tryDecodeBolt11(
        'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns',
      ),
    ).toBeNull()
  })

  it('skips a second p tag per spec and unknown tags without complaint', () => {
    const inv = buildInvoice('lnbc1u', [P, tag(1, words52('c3'.repeat(32))), tag(19, Array(53).fill(1))])
    expect(decodeBolt11(inv).paymentHashHex).toBe(HASH)
  })
})

describe('v4v-compatible aliases', () => {
  it('bolt11PaymentHash mirrors preimage-rail semantics', () => {
    expect(bolt11PaymentHash(SPEC_INVOICE)).toBe(SPEC_HASH)
    expect(bolt11PaymentHash(SPEC_INVOICE.toUpperCase())).toBe(SPEC_HASH)
    expect(bolt11PaymentHash('')).toBeNull()
    expect(bolt11PaymentHash('lnmock1placeholder')).toBeNull()
  })

  it('bolt11AmountMsats mirrors preimage-rail semantics', () => {
    expect(bolt11AmountMsats(buildInvoice('lnbc21u', [P]))).toBe(2_100_000)
    expect(bolt11AmountMsats(buildInvoice('lnbc', [P]))).toBeNull()
    expect(bolt11AmountMsats('lnbc21u1not-valid')).toBeNull()
  })

  it('verifyInvoiceCommitment accepts a match, refuses opaque unless told otherwise', () => {
    expect(verifyInvoiceCommitment({ bolt11: SPEC_INVOICE, paymentHash: SPEC_HASH })).toEqual({
      ok: true,
      verified: true,
    })
    expect(verifyInvoiceCommitment({ bolt11: SPEC_INVOICE, paymentHash: 'ff'.repeat(32) }).ok).toBe(false)
    expect(verifyInvoiceCommitment({ bolt11: 'lnmock1x', paymentHash: SPEC_HASH }).ok).toBe(false)
    const deferred = verifyInvoiceCommitment({
      bolt11: 'lnmock1x',
      paymentHash: SPEC_HASH,
      requireDecodable: false,
    })
    expect(deferred).toMatchObject({ ok: true, verified: false })
    expect(verifyInvoiceCommitment({ bolt11: SPEC_INVOICE, paymentHash: 'nope' }).ok).toBe(false)
  })
})

describe('cross-validation against light-bolt11-decoder', () => {
  const fixtures = [
    SPEC_INVOICE,
    buildInvoice('lnbc2500u', [P, tag(13, utf8Words('1 cup coffee')), tag(6, numberWords(60))]),
    buildInvoice('lnbcrt21000n', [P, tag(16, words52('b2'.repeat(32)))]),
    buildInvoice('lntbs15n', [P]),
  ]

  it.each(fixtures.map((f, i) => [i, f] as const))('fixture %i agrees field-for-field', (_i, invoice) => {
    const ours = decodeBolt11(invoice)
    const theirs = lightDecode(invoice) as {
      sections: Array<{ name?: string; value?: unknown }>
    }
    const section = (name: string) => theirs.sections.find((s) => s.name === name)?.value
    expect(ours.paymentHashHex).toBe(section('payment_hash'))
    const theirAmount = section('amount')
    expect(ours.amountMsats === null ? undefined : String(ours.amountMsats)).toBe(theirAmount)
    const theirDescription = section('description')
    if (theirDescription !== undefined) expect(ours.description).toBe(theirDescription)
    const theirExpiry = section('expiry')
    if (theirExpiry !== undefined) expect(ours.expirySeconds).toBe(theirExpiry)
    expect(ours.timestamp).toBe(section('timestamp'))
  })
})
