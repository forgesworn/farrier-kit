// Conformance harness: assert farrier-kit reproduces every frozen vector in
// vectors/*.json. These JSON files are the language-neutral contract a Kotlin,
// Swift or Rust port validates against, this test proves the reference TS
// implementation still honours them, so CI fails the instant it drifts.
//
// Regenerate the vectors (from independent oracles) with:
//   node scripts/gen-vectors.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'
import { decodeBolt11, tryDecodeBolt11 } from '../src/bolt11.js'
import { computePaymentHash, verifyPreimage } from '../src/preimage.js'
import { isPrivateIpLiteral, lnurlPayUrl, parseLightningAddress } from '../src/lnurl.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const load = (name: string): any => JSON.parse(readFileSync(join(HERE, name), 'utf8'))
const sha256Utf8 = (text: string) => bytesToHex(sha256(new TextEncoder().encode(text)))

describe('conformance: vectors/bolt11.json', () => {
  const { valid, errors } = load('bolt11.json')
  for (const v of valid) {
    it(`decodes ${v.name}`, () => {
      const d = decodeBolt11(v.invoice)
      expect(d.network).toBe(v.decoded.network)
      expect(d.amountMsats === null ? null : d.amountMsats.toString()).toBe(v.decoded.amountMsats)
      expect(d.paymentHashHex).toBe(v.decoded.paymentHashHex)
      expect(d.expirySeconds).toBe(v.decoded.expirySeconds)
      expect(d.timestamp).toBe(v.decoded.timestamp)
      if (v.decoded.description !== null) expect(d.description).toBe(v.decoded.description)
    })
  }
  for (const v of errors) {
    it(`rejects ${v.name}`, () => {
      expect(tryDecodeBolt11(v.invoice)).toBeNull()
    })
  }
})

describe('conformance: vectors/preimage.json', () => {
  const { hash, verify } = load('preimage.json')
  for (const h of hash) {
    it(`SHA-256(${h.preimage.slice(0, 12)}…) matches the frozen payment hash`, () => {
      expect(computePaymentHash(h.preimage)).toBe(h.paymentHash.toLowerCase())
    })
  }
  verify.forEach((v: any, i: number) => {
    it(`verify: ${v.note ?? `case ${i}`}`, () => {
      expect(verifyPreimage(v.preimage, v.paymentHash)).toBe(v.valid)
    })
  })
})

describe('conformance: vectors/lightning-address.json', () => {
  const { valid, invalid, lnurlpUrl } = load('lightning-address.json')
  for (const v of valid) {
    it(`parses ${v.input}`, () => {
      expect(parseLightningAddress(v.input)).toEqual({ address: `${v.name}@${v.domain}`, name: v.name, domain: v.domain })
    })
  }
  for (const s of invalid) {
    it(`rejects ${JSON.stringify(s)}`, () => {
      expect(() => parseLightningAddress(s)).toThrow()
    })
  }
  for (const v of lnurlpUrl) {
    it(`builds ${v.url}`, () => {
      expect(lnurlPayUrl({ name: v.name, domain: v.domain })).toBe(v.url)
    })
  }
})

describe('conformance: vectors/ssrf.json', () => {
  const { private: priv, public: pub } = load('ssrf.json')
  for (const h of priv) {
    it(`classifies ${h} as private`, () => {
      expect(isPrivateIpLiteral(h)).toBe(true)
    })
  }
  for (const h of pub) {
    it(`classifies ${h} as public`, () => {
      expect(isPrivateIpLiteral(h)).toBe(false)
    })
  }
})

describe('conformance: vectors/description-hash.json', () => {
  // description_hash = SHA-256(utf8(input)), LUD-06 metadata or a NIP-57 zap
  // request. This is what resolveLnurlPay checks the invoice's h tag against.
  for (const v of load('description-hash.json').vectors) {
    it(`${v.kind}`, () => {
      expect(sha256Utf8(v.input)).toBe(v.descriptionHashHex)
    })
  }
})
