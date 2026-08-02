// LNURL-pay resolution (LUD-06/16), LUD-21 verify, and capability probing.
//
// The merged superset of two production implementations: SSRF hardening,
// comment truncation and NIP-57 zap requests from one; LUD-21 verify-URL
// capture from the other. Plus two checks neither had: the returned invoice's
// amount must equal the requested amount, and a LUD-21 preimage is
// cross-checked against the payment hash rather than trusted.

import { decodeBolt11 } from './bolt11.js'
import { fetchJson, type FetchJsonOptions } from './http.js'
import { verifyPreimage } from './preimage.js'

export class LnurlError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LnurlError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new LnurlError(code, message)
}

// ---------------------------------------------------------------------------
// Lightning Addresses

export interface LightningAddress {
  /** Canonical form: original name, lowercased domain. */
  address: string
  name: string
  domain: string
}

const ADDRESS_RE = /^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/i

export function isLightningAddress(handle: string): boolean {
  return typeof handle === 'string' && ADDRESS_RE.test(handle.trim())
}

/**
 * Parse name@domain, or throw LnurlError BAD_ADDRESS. Both halves are
 * lowercased: LUD-16 restricts usernames to lowercase a-z0-9-_. and services
 * treat them case-insensitively.
 */
export function parseLightningAddress(address: string): LightningAddress {
  const value = String(address ?? '').trim()
  const match = value.match(ADDRESS_RE)
  if (!match) fail('BAD_ADDRESS', 'not a valid Lightning Address (name@domain)')
  const name = match[1].toLowerCase()
  const domain = match[2].toLowerCase()
  if (domain === 'localhost' || domain.endsWith('.local') || domain.endsWith('.localhost')) {
    fail('BAD_ADDRESS', 'Lightning Address must use a public domain')
  }
  return { address: `${name}@${domain}`, name, domain }
}

/** The LUD-16 well-known URL for an address. */
export function lnurlPayUrl({ name, domain }: { name: string; domain: string }): string {
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`
}

// ---------------------------------------------------------------------------
// URL guarding (SSRF). Browser-safe: shape checks plus literal-IP
// classification. Servers that can resolve DNS should ALSO pin resolved
// addresses via the injectable urlGuard option.

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && octets[2] === 2) return true // TEST-NET-1
  if (a === 198 && octets[1] === 51 && octets[2] === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/** True when hostname is an IP literal in a private/reserved range. */
export function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some((o) => o > 255)) return true // malformed: refuse
    return isPrivateIpv4(octets)
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    if (/^f[cd]/.test(host)) return true // fc00::/7 unique local
    if (/^fe[89ab]/.test(host)) return true // fe80::/10 link local
    if (host.startsWith('2001:db8')) return true // documentation
    const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return isPrivateIpLiteral(mapped[1])
    return false
  }
  return false
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')
}

/**
 * HTTPS-only, public-host URL check. Throws LnurlError on violation.
 * This is the browser-safe half; pass a urlGuard doing DNS resolution for
 * full server-side SSRF pinning.
 */
export function assertResolvableUrl(input: string | URL): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(String(input ?? ''))
  } catch {
    fail('BAD_URL', 'not a URL')
  }
  if (url.protocol !== 'https:') fail('BAD_URL', 'LNURL endpoints must use HTTPS')
  const hostname = url.hostname.toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    fail('BAD_URL', 'LNURL endpoints must use a public host')
  }
  if (isIpLiteral(hostname) && isPrivateIpLiteral(hostname)) {
    fail('BAD_URL', 'LNURL endpoint points at a private or reserved address')
  }
  return url
}

// ---------------------------------------------------------------------------
// LUD-06/16 resolution

export interface LnurlPayMetadata {
  tag: string
  callback: string
  minSendable: number
  maxSendable: number
  commentAllowed: number
  allowsNostr: boolean
  nostrPubkey: string
  /** The raw LUD-06 metadata JSON string (description-hash preimage). */
  metadata: string
}

export interface ResolveLnurlPayOptions {
  /** Lightning Address (name@domain). Mutually exclusive with lnurlpUrl. */
  address?: string
  /** A direct LUD-06 endpoint URL, for non-address LNURLs. */
  lnurlpUrl?: string
  amountSats?: number
  amountMsats?: bigint | number
  /** LUD-12 comment; truncated to the service's commentAllowed. */
  comment?: string
  /** NIP-57: a JSON-encoded signed zap request; sent when the service allows it. */
  nostr?: string
  fetchImpl?: FetchJsonOptions['fetchImpl']
  timeoutMs?: number
  /**
   * Extra async URL check (e.g. server-side DNS resolution pinning) applied
   * to both the well-known URL and the callback after the built-in guard.
   */
  urlGuard?: (url: URL) => void | Promise<void>
}

export interface ResolvedLnurlPay {
  address: string | null
  amountMsats: bigint
  amountSats: number | null
  bolt11: string
  paymentHashHex: string
  /** LUD-21 verify URL when the service offers one. */
  verifyUrl: string | null
  /** True when the nostr zap request was attached to the callback. */
  zap: boolean
  metadata: LnurlPayMetadata
}

function toMsats(opts: { amountSats?: number; amountMsats?: bigint | number }): bigint {
  if (opts.amountMsats !== undefined) {
    const v = typeof opts.amountMsats === 'bigint' ? opts.amountMsats : BigInt(Math.trunc(opts.amountMsats))
    if (v <= 0n) fail('BAD_AMOUNT', 'amountMsats must be positive')
    return v
  }
  if (opts.amountSats !== undefined) {
    if (!Number.isInteger(opts.amountSats) || opts.amountSats <= 0) {
      fail('BAD_AMOUNT', 'amountSats must be a positive integer')
    }
    return BigInt(opts.amountSats) * 1000n
  }
  fail('BAD_AMOUNT', 'one of amountSats or amountMsats is required')
}

function readMetadata(body: Record<string, unknown>): LnurlPayMetadata {
  if (body.status === 'ERROR') fail('SERVICE_ERROR', String(body.reason ?? 'LNURL service returned an error'))
  if (body.tag !== undefined && body.tag !== 'payRequest') fail('NOT_PAYREQUEST', 'endpoint is not an LNURL-pay service')
  if (typeof body.callback !== 'string' || !body.callback) fail('NO_CALLBACK', 'LNURL-pay response has no callback URL')
  return {
    tag: String(body.tag ?? ''),
    callback: body.callback,
    minSendable: Number(body.minSendable ?? 0),
    maxSendable: Number(body.maxSendable ?? 0),
    commentAllowed: Number(body.commentAllowed ?? 0),
    allowsNostr: Boolean(body.allowsNostr),
    nostrPubkey: typeof body.nostrPubkey === 'string' ? body.nostrPubkey : '',
    metadata: typeof body.metadata === 'string' ? body.metadata : '',
  }
}

async function guardedFetchJson(
  url: string | URL,
  opts: Pick<ResolveLnurlPayOptions, 'fetchImpl' | 'timeoutMs' | 'urlGuard'>,
): Promise<Record<string, unknown>> {
  const checked = assertResolvableUrl(url)
  await opts.urlGuard?.(checked)
  return fetchJson<Record<string, unknown>>(checked.toString(), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    redirect: 'manual',
  })
}

/**
 * Resolve a Lightning Address (or direct LUD-06 URL) to a bolt11 invoice for
 * an exact amount. The returned invoice has been decoded and its amount
 * verified to equal the request — a mismatched or amountless invoice throws.
 */
export async function resolveLnurlPay(opts: ResolveLnurlPayOptions): Promise<ResolvedLnurlPay> {
  const msats = toMsats(opts)
  let address: string | null = null
  let wellKnown: string
  if (opts.address !== undefined) {
    const parsed = parseLightningAddress(opts.address)
    address = parsed.address
    wellKnown = lnurlPayUrl(parsed)
  } else if (opts.lnurlpUrl) {
    wellKnown = opts.lnurlpUrl
  } else {
    fail('BAD_ADDRESS', 'one of address or lnurlpUrl is required')
  }

  const metadata = readMetadata(await guardedFetchJson(wellKnown, opts))

  if (metadata.minSendable > 0 && msats < BigInt(Math.trunc(metadata.minSendable))) {
    fail('BELOW_MIN', `minimum is ${Math.ceil(metadata.minSendable / 1000)} sats`)
  }
  if (metadata.maxSendable > 0 && msats > BigInt(Math.trunc(metadata.maxSendable))) {
    fail('ABOVE_MAX', `maximum is ${Math.floor(metadata.maxSendable / 1000)} sats`)
  }

  let callback: URL
  try {
    callback = new URL(metadata.callback)
  } catch {
    fail('BAD_URL', 'LNURL-pay callback is not a URL')
  }
  callback.searchParams.set('amount', msats.toString())
  const zap = Boolean(opts.nostr) && metadata.allowsNostr && Boolean(metadata.nostrPubkey)
  if (zap) {
    callback.searchParams.set('nostr', String(opts.nostr))
  } else if (opts.comment && metadata.commentAllowed > 0) {
    callback.searchParams.set('comment', String(opts.comment).slice(0, metadata.commentAllowed))
  }

  const invoiceBody = await guardedFetchJson(callback, opts)
  if (invoiceBody.status === 'ERROR') {
    fail('SERVICE_ERROR', String(invoiceBody.reason ?? 'LNURL callback returned an error'))
  }
  if (typeof invoiceBody.pr !== 'string' || !invoiceBody.pr) {
    fail('NO_INVOICE', 'LNURL callback did not return a bolt11 invoice')
  }

  const bolt11 = invoiceBody.pr
  let decoded
  try {
    decoded = decodeBolt11(bolt11)
  } catch (error) {
    fail('BAD_INVOICE', `service returned an undecodable invoice: ${(error as Error).message}`)
  }
  if (decoded.amountMsats === null) fail('AMOUNT_MISMATCH', 'service returned an amountless invoice')
  if (decoded.amountMsats !== msats) {
    fail('AMOUNT_MISMATCH', `invoice is for ${decoded.amountMsats} msat, requested ${msats} msat`)
  }

  const verify = invoiceBody.verify
  return {
    address,
    amountMsats: msats,
    amountSats: msats % 1000n === 0n ? Number(msats / 1000n) : null,
    bolt11,
    paymentHashHex: decoded.paymentHashHex,
    verifyUrl: typeof verify === 'string' && verify ? verify : null,
    zap,
    metadata,
  }
}

// ---------------------------------------------------------------------------
// LUD-21 verify

export interface Lud21Result {
  /** True when the service says the invoice is settled. */
  settled: boolean
  /** Preimage as returned by the service, when present. */
  preimage: string | null
  /**
   * True only when a returned preimage was cryptographically checked against
   * paymentHashHex. A settled=true with verified=false is the service's word,
   * not proof.
   */
  verified: boolean
}

export async function verifyLud21({
  verifyUrl,
  paymentHashHex,
  fetchImpl,
  timeoutMs,
  urlGuard,
}: {
  verifyUrl: string
  paymentHashHex?: string
  fetchImpl?: FetchJsonOptions['fetchImpl']
  timeoutMs?: number
  urlGuard?: (url: URL) => void | Promise<void>
}): Promise<Lud21Result> {
  const body = await guardedFetchJson(verifyUrl, { fetchImpl, timeoutMs, urlGuard })
  if (body.status === 'ERROR') fail('SERVICE_ERROR', String(body.reason ?? 'LUD-21 verify returned an error'))
  const settled = body.status === 'OK' && Boolean(body.settled)
  const preimage = typeof body.preimage === 'string' && body.preimage ? body.preimage : null
  const verified = Boolean(settled && preimage && paymentHashHex && verifyPreimage(preimage, paymentHashHex))
  return { settled, preimage, verified }
}

// ---------------------------------------------------------------------------
// Capability probing (metadata-only, cached)

export interface LnurlPayCapability {
  ok: boolean
  reason?: string
  address: string
  minSendable: number
  maxSendable: number
  commentAllowed: number
  allowsNostr: boolean
  nostrPubkey: string
}

export interface CapabilityProbe {
  probe(address: string): Promise<LnurlPayCapability>
  /** Drop one address, or everything. */
  invalidate(address?: string): void
}

/**
 * A TTL-cached, metadata-only prober: "can this address take N sats, with a
 * comment, as a zap?" without ever requesting an invoice.
 */
export function createCapabilityProbe({
  fetchImpl,
  timeoutMs,
  urlGuard,
  cacheTtlMs = 5 * 60 * 1000,
  now = () => Date.now(),
}: Pick<ResolveLnurlPayOptions, 'fetchImpl' | 'timeoutMs' | 'urlGuard'> & {
  cacheTtlMs?: number
  now?: () => number
} = {}): CapabilityProbe {
  const cache = new Map<string, { at: number; value: LnurlPayCapability }>()
  return {
    async probe(address: string): Promise<LnurlPayCapability> {
      const parsed = parseLightningAddress(address)
      const hit = cache.get(parsed.address)
      if (hit && now() - hit.at < cacheTtlMs) return hit.value
      let value: LnurlPayCapability
      try {
        const metadata = readMetadata(await guardedFetchJson(lnurlPayUrl(parsed), { fetchImpl, timeoutMs, urlGuard }))
        value = {
          ok: true,
          address: parsed.address,
          minSendable: metadata.minSendable,
          maxSendable: metadata.maxSendable,
          commentAllowed: metadata.commentAllowed,
          allowsNostr: metadata.allowsNostr,
          nostrPubkey: metadata.nostrPubkey,
        }
      } catch (error) {
        value = {
          ok: false,
          reason: (error as Error).message,
          address: parsed.address,
          minSendable: 0,
          maxSendable: 0,
          commentAllowed: 0,
          allowsNostr: false,
          nostrPubkey: '',
        }
      }
      cache.set(parsed.address, { at: now(), value })
      return value
    },
    invalidate(address?: string) {
      if (address === undefined) cache.clear()
      else cache.delete(parseLightningAddress(address).address)
    },
  }
}
