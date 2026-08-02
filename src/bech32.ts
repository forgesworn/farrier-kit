// Minimal bech32 (BIP-0173), dependency-free and browser-safe.
//
// Two deliberate deviations from BIP-173, both required by consumers:
//   - No 90-character cap. BOLT-11 invoices with route hints and LNURL (LUD-01)
//     strings both run far past it. A configurable upper bound stays as the
//     DoS guard.
//   - Decode returns null rather than throwing: every caller treats "not
//     bech32" as an expected input class (user-pasted strings), not an error.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod(hrpExpand(hrp).concat(data)) === 1
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])
  const mod = polymod(values) ^ 1
  const out: number[] = []
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31)
  return out
}

export function bech32Encode(hrp: string, data: number[]): string {
  const combined = data.concat(createChecksum(hrp, data))
  let out = `${hrp}1`
  for (const d of combined) out += CHARSET.charAt(d)
  return out
}

export interface Bech32Decoded {
  hrp: string
  /** 5-bit data words, checksum stripped. */
  data: number[]
}

export function bech32Decode(str: string, maxLength = 8192): Bech32Decoded | null {
  if (typeof str !== 'string' || str.length < 8 || str.length > maxLength) return null
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null // no mixed case
  const s = str.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length) return null
  const hrp = s.slice(0, pos)
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i)
    if (c < 33 || c > 126) return null
  }
  const data: number[] = []
  for (let i = pos + 1; i < s.length; i++) {
    const d = CHARSET.indexOf(s.charAt(i))
    if (d === -1) return null
    data.push(d)
  }
  if (!verifyChecksum(hrp, data)) return null
  return { hrp, data: data.slice(0, data.length - 6) }
}

/**
 * Regroup bits between word sizes (e.g. 8-bit bytes <-> 5-bit bech32 words).
 * With pad=false, leftover bits must be shorter than a source word and zero —
 * the strict mode BIP-173 requires for fixed-size fields.
 */
export function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || (acc << (to - bits)) & maxv) {
    return null
  }
  return out
}
