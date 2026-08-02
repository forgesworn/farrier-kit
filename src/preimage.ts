// Preimage <-> payment_hash utilities. The signature set is API-compatible
// with escrow-kit's src/preimage.ts so that repo (and toll-booth's three
// inline copies) can adopt by re-export.

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'

/** Validate that a string is a 64-character hexadecimal value (32 bytes). */
export function isValidHex64(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

/**
 * Generate a cryptographically random 32-byte preimage as a 64-char hex
 * string. Entropy is injectable for deterministic tests and for callers whose
 * wallet already fixed the secret.
 */
export function generatePreimage(entropy?: string): string {
  if (entropy !== undefined) {
    if (!isValidHex64(entropy)) {
      throw new Error(`Invalid preimage entropy: expected 64-character hex string`)
    }
    return entropy.toLowerCase()
  }
  return bytesToHex(randomBytes(32))
}

/** Compute the SHA-256 payment hash of a preimage. Throws if not valid 64-char hex. */
export function computePaymentHash(preimage: string): string {
  if (!isValidHex64(preimage)) {
    throw new Error(`Invalid preimage: expected 64-character hex string, got "${preimage}"`)
  }
  return bytesToHex(sha256(hexToBytes(preimage.toLowerCase())))
}

function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  const a = hexToBytes(aHex)
  const b = hexToBytes(bHex)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Verify that SHA-256(preimage) === expectedHash. Constant-time comparison. */
export function verifyPreimage(preimage: string, expectedHash: string): boolean {
  if (!isValidHex64(preimage) || !isValidHex64(expectedHash)) return false
  const actual = bytesToHex(sha256(hexToBytes(preimage.toLowerCase())))
  return constantTimeEqualHex(actual, expectedHash.toLowerCase())
}

export interface PreimageVerdict {
  ok: boolean
  reason?: string
}

/**
 * verifyPreimage with reasons, for callers surfacing tri-state outcomes
 * (verified / failed / recorded) to users rather than a bare boolean.
 */
export function explainPreimage({
  preimage,
  paymentHash,
}: {
  preimage: string
  paymentHash: string
}): PreimageVerdict {
  if (!isValidHex64(preimage)) return { ok: false, reason: 'preimage must be 32-byte hex' }
  if (!isValidHex64(paymentHash)) return { ok: false, reason: 'payment_hash must be 32-byte hex' }
  if (!verifyPreimage(preimage, paymentHash)) {
    return { ok: false, reason: 'preimage does not hash to the committed payment_hash' }
  }
  return { ok: true }
}
