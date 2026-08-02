// BOLT-11 invoice decoding: the read-only fields a payer or verifier needs
// before and after money moves. No signature recovery, no route hints — a
// payer's wallet does that; this answers "what does this invoice commit to?"
//
// Layout after bech32: 7 words of timestamp, tagged fields
// [type | len_hi | len_lo | data...], then a 104-word signature.

import { bech32Decode, convertBits } from './bech32.js'

const SIGNATURE_WORDS = 104
const TIMESTAMP_WORDS = 7

// Tag types per BOLT-11.
const TAG_PAYMENT_HASH = 1 // p
const TAG_DESCRIPTION = 13 // d
const TAG_PAYMENT_SECRET = 16 // s
const TAG_DESCRIPTION_HASH = 23 // h
const TAG_EXPIRY = 6 // x
const TAG_MIN_FINAL_CLTV = 24 // c

/** BOLT-11: an invoice with no x tag expires after one hour. */
export const BOLT11_DEFAULT_EXPIRY_SECONDS = 3600

export type Bolt11Network = 'bc' | 'tb' | 'tbs' | 'bcrt' | 'sb'

export interface DecodedBolt11 {
  network: Bolt11Network
  /** Invoice amount in millisatoshis, or null for an amountless invoice. */
  amountMsats: bigint | null
  /**
   * Whole-satoshi amount when amountMsats divides exactly by 1000, otherwise
   * null (never silently floored — use msatsToSatsFloor if you want that).
   */
  amountSats: number | null
  paymentHashHex: string
  paymentSecretHex: string | null
  description: string | null
  descriptionHashHex: string | null
  /** Invoice creation time, seconds since epoch. */
  timestamp: number
  /** Seconds after timestamp at which the invoice expires (spec default 3600). */
  expirySeconds: number
  minFinalCltvExpiry: number | null
}

export class Bolt11Error extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'Bolt11Error'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new Bolt11Error(code, message)
}

function wordsToNumber(words: number[]): number {
  // A numeric field wider than 13 words (ceil(64/5)) exceeds uint64 and, past
  // ~11 words, Number precision — lnd rejects >13 outright. Refuse rather than
  // silently saturate to Infinity or lose precision (expiry/cltv footgun).
  if (words.length > 13) fail('BAD_TAG', 'numeric tag field too long')
  let n = 0
  for (const w of words) n = n * 32 + w
  if (!Number.isSafeInteger(n)) fail('BAD_TAG', 'numeric tag field out of range')
  return n
}

/** Byte content of a variable-length tag: 5-bit words, zero-padded to bytes. */
function wordsToBytes(words: number[]): Uint8Array {
  const padded = convertBits(words, 5, 8, true)
  if (padded === null) fail('BAD_TAG', 'tag data does not regroup to bytes')
  return Uint8Array.from(padded.slice(0, Math.floor((words.length * 5) / 8)))
}

/** Strict 32-byte field (p/s/h tags, 52 words): pad bits must be zero. */
function wordsToHash(words: number[]): string | null {
  if (words.length !== 52) return null
  const bytes = convertBits(words, 5, 8, false)
  if (bytes === null || bytes.length !== 32) return null
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

// One unambiguous shape: ln<net> optionally followed by <digits><multiplier?>.
// The earlier form had a trailing (\d+)? that let "lnbc100u200" parse two ways,
// silently dropping the trailing digits and inventing an amount a strict
// decoder would reject.
const HRP_RE = /^ln(bcrt|bc|tbs|tb|sb)(?:(\d+)([munp])?)?$/

/** Max representable amount: the 21M BTC supply, in msats. */
const MAX_MSATS = 2_100_000_000_000_000_000n

function parseHrp(hrp: string): { network: Bolt11Network; amountMsats: bigint | null } {
  const m = hrp.match(HRP_RE)
  if (!m) fail('BAD_HRP', `not a BOLT-11 human-readable part: "${hrp}"`)
  const network = m[1] as Bolt11Network
  const digits = m[2]
  const unit = m[3]
  if (digits === undefined) return { network, amountMsats: null }
  // Leading zeros are tolerated on read (lnd and light-bolt11-decoder both
  // accept them); rejecting made bolt11AmountMsats return null for a priced
  // invoice, which reads as "amountless" and fails a budget gate open.
  const value = BigInt(digits)
  let msats: bigint
  if (unit === undefined) msats = value * 100_000_000_000n
  else if (unit === 'm') msats = value * 100_000_000n
  else if (unit === 'u') msats = value * 100_000n
  else if (unit === 'n') msats = value * 100n
  else {
    // pico-BTC: 1p = 0.1 msat, so the value must end in 0.
    if (value % 10n !== 0n) fail('BAD_AMOUNT', 'pico-BTC amount is not a whole millisatoshi')
    msats = value / 10n
  }
  if (msats > MAX_MSATS) fail('BAD_AMOUNT', 'amount exceeds the 21M BTC supply')
  return { network, amountMsats: msats }
}

/**
 * Decode a BOLT-11 invoice. Throws Bolt11Error (with a `code`) on anything
 * that is not a checksum-valid invoice carrying a payment hash. Use
 * tryDecodeBolt11 when "not an invoice" is an expected input class.
 */
export function decodeBolt11(invoice: string): DecodedBolt11 {
  const value = String(invoice ?? '').trim()
  if (!/^ln/i.test(value)) fail('NOT_INVOICE', 'does not start with "ln"')
  const decoded = bech32Decode(value)
  if (!decoded) fail('BAD_BECH32', 'not valid bech32 (charset, case or checksum)')
  const { network, amountMsats } = parseHrp(decoded.hrp)
  if (decoded.data.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) {
    fail('TRUNCATED', 'shorter than timestamp + signature')
  }
  const timestamp = wordsToNumber(decoded.data.slice(0, TIMESTAMP_WORDS))
  const fields = decoded.data.slice(TIMESTAMP_WORDS, decoded.data.length - SIGNATURE_WORDS)

  let paymentHashHex: string | null = null
  let paymentSecretHex: string | null = null
  let description: string | null = null
  let descriptionHashHex: string | null = null
  let expirySeconds: number | null = null
  let minFinalCltvExpiry: number | null = null

  // Spec: for repeated tags the FIRST occurrence wins. Track "seen" separately
  // from "parsed value" so a malformed first s/h tag still claims its slot and
  // a later duplicate cannot override it (matters: h is the description-hash
  // commitment).
  let sawPaymentHash = false
  let sawSecret = false
  let sawDescHash = false

  let i = 0
  while (i + 3 <= fields.length) {
    const type = fields[i]
    const length = fields[i + 1] * 32 + fields[i + 2]
    const data = fields.slice(i + 3, i + 3 + length)
    if (data.length < length) fail('BAD_TAG', 'tag runs past the end of the invoice')
    switch (type) {
      case TAG_PAYMENT_HASH:
        if (!sawPaymentHash) {
          sawPaymentHash = true
          paymentHashHex = wordsToHash(data)
          if (paymentHashHex === null) fail('BAD_PAYMENT_HASH', 'p tag is not a clean 32-byte field')
        }
        break
      case TAG_PAYMENT_SECRET:
        if (!sawSecret) {
          sawSecret = true
          paymentSecretHex = wordsToHash(data)
        }
        break
      case TAG_DESCRIPTION_HASH:
        if (!sawDescHash) {
          sawDescHash = true
          descriptionHashHex = wordsToHash(data)
        }
        break
      case TAG_DESCRIPTION:
        if (description === null) description = new TextDecoder().decode(wordsToBytes(data))
        break
      case TAG_EXPIRY:
        if (expirySeconds === null) expirySeconds = wordsToNumber(data)
        break
      case TAG_MIN_FINAL_CLTV:
        if (minFinalCltvExpiry === null) minFinalCltvExpiry = wordsToNumber(data)
        break
      default:
        break // unknown tags are legal; skip
    }
    i += 3 + length
  }

  if (paymentHashHex === null) fail('MISSING_PAYMENT_HASH', 'invoice carries no p tag')

  const amountSats =
    amountMsats !== null && amountMsats % 1000n === 0n && amountMsats / 1000n <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(amountMsats / 1000n)
      : null

  return {
    network,
    amountMsats,
    amountSats,
    paymentHashHex,
    paymentSecretHex,
    description,
    descriptionHashHex,
    timestamp,
    expirySeconds: expirySeconds ?? BOLT11_DEFAULT_EXPIRY_SECONDS,
    minFinalCltvExpiry,
  }
}

/** decodeBolt11, but null instead of a throw for undecodable input. */
export function tryDecodeBolt11(invoice: string): DecodedBolt11 | null {
  try {
    return decodeBolt11(invoice)
  } catch {
    return null
  }
}

/**
 * Extract the payment_hash from a bolt11 invoice, or null when the string is
 * not decodable bolt11. Name-compatible with v4v's preimage-rail export.
 */
export function bolt11PaymentHash(bolt11: string): string | null {
  return tryDecodeBolt11(bolt11)?.paymentHashHex ?? null
}

/**
 * Amount from the human-readable part, normalised to millisatoshis as a
 * number, or null when amountless, undecodable, or past MAX_SAFE_INTEGER.
 * Name-compatible with v4v's preimage-rail export.
 */
export function bolt11AmountMsats(bolt11: string): number | null {
  const msats = tryDecodeBolt11(bolt11)?.amountMsats ?? null
  if (msats === null) return null
  return msats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(msats) : null
}

/** Explicitly-floored msat -> sat conversion (sub-satoshi remainder dropped). */
export function msatsToSatsFloor(msats: bigint | number): number {
  if (typeof msats === 'number' && !Number.isFinite(msats)) {
    throw new Bolt11Error('BAD_AMOUNT', 'amount is not a finite number')
  }
  const v = typeof msats === 'bigint' ? msats : BigInt(Math.floor(msats))
  if (v < 0n) throw new Bolt11Error('BAD_AMOUNT', 'amount is negative')
  const sats = v / 1000n
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Bolt11Error('OVERFLOW', 'amount exceeds MAX_SAFE_INTEGER sats')
  return Number(sats)
}

export interface CommitmentVerdict {
  ok: boolean
  /** true when the invoice was decoded and its hash compared; absent/false on refusal or deferral. */
  verified?: boolean
  reason?: string
  /** The decoded invoice amount (msats), so callers can gate on it even without expectedMsats. */
  amountMsats?: bigint | null
  /** The decoded network, so callers can reject a wrong-chain invoice. */
  network?: Bolt11Network
}

/**
 * The payer's pre-payment check: does this invoice commit to the expected
 * payment_hash — AND, when given, the expected amount and network?
 *
 * The payment_hash alone is NOT enough: the payee picks the preimage, so they
 * can mint a second invoice with the same hash and any amount. Pass
 * `expectedMsats` (and rely on the default `network: 'bc'`) whenever real money
 * is about to move. Opaque invoices cannot be pre-verified; `requireDecodable`
 * must stay true in that case so an unverifiable invoice refuses rather than
 * pays — and note a deferral returns `ok:true` only for post-hoc detection, so
 * never treat `ok:true, verified:false` as "safe to pay".
 */
export function verifyInvoiceCommitment({
  bolt11,
  paymentHash,
  expectedMsats,
  network = 'bc',
  requireDecodable = true,
}: {
  bolt11: string
  paymentHash: string
  /** When supplied, the invoice amount must equal this exactly. */
  expectedMsats?: bigint | number
  /** Required network; pass null to skip. Defaults to mainnet ('bc'). */
  network?: Bolt11Network | null
  requireDecodable?: boolean
}): CommitmentVerdict {
  if (typeof paymentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
    return { ok: false, reason: 'no payment_hash to verify against' }
  }
  const decoded = tryDecodeBolt11(bolt11)
  if (decoded === null) {
    return requireDecodable
      ? { ok: false, reason: 'invoice is not decodable bolt11; refusing to pay unverified' }
      : { ok: true, verified: false, reason: 'opaque invoice; deferred to the preimage hash check' }
  }
  if (decoded.paymentHashHex !== paymentHash.toLowerCase()) {
    return { ok: false, reason: 'invoice payment_hash does not match the expected commitment', amountMsats: decoded.amountMsats, network: decoded.network }
  }
  if (network !== null && decoded.network !== network) {
    return { ok: false, reason: `invoice is on ${decoded.network}, expected ${network}`, amountMsats: decoded.amountMsats, network: decoded.network }
  }
  if (expectedMsats !== undefined) {
    if (typeof expectedMsats === 'number' && !Number.isSafeInteger(expectedMsats)) {
      // NaN/Infinity/fractional: return a verdict (fail closed) rather than
      // throwing a raw RangeError from BigInt() — this is an exact payment gate.
      return { ok: false, reason: 'expectedMsats must be a safe integer', amountMsats: decoded.amountMsats, network: decoded.network }
    }
    const want = typeof expectedMsats === 'bigint' ? expectedMsats : BigInt(expectedMsats)
    if (decoded.amountMsats === null) {
      return { ok: false, reason: 'invoice is amountless but an exact amount was required', network: decoded.network }
    }
    if (decoded.amountMsats !== want) {
      return { ok: false, reason: `invoice is for ${decoded.amountMsats} msat, expected ${want} msat`, amountMsats: decoded.amountMsats, network: decoded.network }
    }
  }
  return { ok: true, verified: true, amountMsats: decoded.amountMsats, network: decoded.network }
}
