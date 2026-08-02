import { describe, expect, it } from 'vitest'
import { bech32Decode, bech32Encode, convertBits } from './bech32.js'

describe('bech32 (BIP-173)', () => {
  it('accepts spec-valid strings', () => {
    for (const valid of [
      'A12UEL5L',
      'a12uel5l',
      'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
      'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
    ]) {
      expect(bech32Decode(valid), valid).not.toBeNull()
    }
  })

  it('rejects invalid strings', () => {
    for (const invalid of [
      'A12UEL5l', // mixed case
      'A12UEL5M', // corrupt checksum
      'pzry9x8gf2tvdw0s3jn54khce6mua7l', // no separator
      '1qzry9x8gf2tvdw0s3jn54khce6mua7l', // empty hrp
      'abc1rzgb', // too short for a checksum
      'de1lg7wtqpzry9x8gf2tvdw0s3jn54khce6mua7', // charset violation would fail checksum anyway
      '',
    ]) {
      expect(bech32Decode(invalid), JSON.stringify(invalid)).toBeNull()
    }
  })

  it('round-trips encode -> decode', () => {
    const data = [0, 1, 2, 3, 31, 30, 15]
    const encoded = bech32Encode('farrier', data)
    const decoded = bech32Decode(encoded)
    expect(decoded).toEqual({ hrp: 'farrier', data })
  })

  it('enforces the DoS length guard but not the 90-char BIP cap', () => {
    const long = bech32Encode('ln', Array(200).fill(0))
    expect(long.length).toBeGreaterThan(90)
    expect(bech32Decode(long)).not.toBeNull()
    expect(bech32Decode(long, 50)).toBeNull()
  })

  it('convertBits strict mode rejects nonzero padding, pad mode keeps it', () => {
    // 52 words of 5 bits = 260 bits = 32 bytes + 4 zero pad bits.
    const words = convertBits(Array.from({ length: 32 }, (_, i) => i * 7 % 256), 8, 5, true)!
    expect(words).toHaveLength(52)
    expect(convertBits(words, 5, 8, false)).toHaveLength(32)
    const dirty = [...words]
    dirty[51] |= 1 // nonzero pad bit
    expect(convertBits(dirty, 5, 8, false)).toBeNull()
    expect(convertBits(dirty, 5, 8, true)).toHaveLength(33)
  })
})
