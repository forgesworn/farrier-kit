import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  computePaymentHash,
  explainPreimage,
  generatePreimage,
  isValidHex64,
  verifyPreimage,
} from './preimage.js'

// This block is escrow-kit's suite, kept verbatim as the API-compatibility
// proof (adoption there is by re-export).
describe('preimage utilities (escrow-kit compatibility)', () => {
  it('generates a 64-char hex preimage', () => {
    const p = generatePreimage()
    expect(isValidHex64(p)).toBe(true)
  })
  it('round-trips preimage -> hash -> verify', () => {
    const p = generatePreimage()
    const h = computePaymentHash(p)
    expect(isValidHex64(h)).toBe(true)
    expect(verifyPreimage(p, h)).toBe(true)
  })
  it('rejects a wrong preimage', () => {
    const h = computePaymentHash(generatePreimage())
    expect(verifyPreimage(generatePreimage(), h)).toBe(false)
  })
  it('throws computing a hash from invalid input', () => {
    expect(() => computePaymentHash('nothex')).toThrow(/Invalid preimage/)
  })
  it('returns false when expectedHash is not valid hex', () => {
    const p = generatePreimage()
    expect(verifyPreimage(p, 'not-hex')).toBe(false)
  })
  it('returns false when preimage is not valid hex', () => {
    const h = computePaymentHash(generatePreimage())
    expect(verifyPreimage('not-hex', h)).toBe(false)
  })
})

describe('preimage extensions', () => {
  it('matches node:crypto sha256 (independent implementation)', () => {
    const p = generatePreimage()
    const reference = createHash('sha256').update(Buffer.from(p, 'hex')).digest('hex')
    expect(computePaymentHash(p)).toBe(reference)
  })

  it('accepts injected entropy, normalised to lowercase', () => {
    const entropy = 'AB'.repeat(32)
    expect(generatePreimage(entropy)).toBe('ab'.repeat(32))
    expect(() => generatePreimage('nope')).toThrow(/entropy/)
  })

  it('is case-insensitive on both sides of verification', () => {
    const p = generatePreimage()
    const h = computePaymentHash(p)
    expect(verifyPreimage(p.toUpperCase(), h.toUpperCase())).toBe(true)
  })

  it('two generated preimages never collide', () => {
    expect(generatePreimage()).not.toBe(generatePreimage())
  })

  it('explainPreimage gives reasons', () => {
    const p = generatePreimage()
    const h = computePaymentHash(p)
    expect(explainPreimage({ preimage: p, paymentHash: h })).toEqual({ ok: true })
    expect(explainPreimage({ preimage: 'bad', paymentHash: h }).reason).toMatch(/32-byte hex/)
    expect(explainPreimage({ preimage: p, paymentHash: 'bad' }).reason).toMatch(/32-byte hex/)
    expect(
      explainPreimage({ preimage: p, paymentHash: 'ff'.repeat(32) }).reason,
    ).toMatch(/does not hash/)
  })
})
