// Shared test-only fixtures: synthesise checksum-valid BOLT-11 invoices.
// Signatures are zeros — neither this decoder nor light-bolt11-decoder
// verifies them, and zeros keep fixtures deterministic.

import { bech32Encode, convertBits } from './bech32.js'

// BOLT-11 spec vector ("Please make a donation of any amount using
// payment_hash 0001...0102 to me").
export const SPEC_INVOICE =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmw' +
  'wd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz' +
  '9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'
export const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102'

export interface TestTag {
  type: number
  words: number[]
}

export function tag(type: number, words: number[]): TestTag {
  return { type, words }
}

export function words52(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return convertBits(bytes, 8, 5, true)!
}

export function utf8Words(text: string): number[] {
  return convertBits([...new TextEncoder().encode(text)], 8, 5, true)!
}

export function numberWords(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    out.unshift(v % 32)
    v = Math.floor(v / 32)
  } while (v > 0)
  return out
}

export function buildInvoice(hrp: string, tags: TestTag[], timestamp = 1_700_000_000): string {
  const data: number[] = []
  for (let i = 6; i >= 0; i--) data.push((timestamp >> (5 * i)) & 31)
  for (const t of tags) {
    data.push(t.type, Math.floor(t.words.length / 32), t.words.length % 32, ...t.words)
  }
  data.push(...Array(104).fill(0))
  return bech32Encode(hrp, data)
}
