// LNURL-pay resolution (LUD-06/16), LUD-21 verify, and capability probing.
//
// The merged superset of two production implementations: SSRF hardening,
// comment truncation and NIP-57 zap requests from one; LUD-21 verify-URL
// capture from the other. Plus two checks neither had: the returned invoice's
// amount must equal the requested amount, and a LUD-21 preimage is
// cross-checked against the payment hash rather than trusted.

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { decodeBolt11, type Bolt11Network } from './bolt11.js'
import { fetchJson, type FetchJsonOptions } from './http.js'
import { verifyPreimage } from './preimage.js'

/** Metadata/comment responses are tiny; cap the fetch to protect against OOM. */
const LNURL_MAX_RESPONSE_BYTES = 256 * 1024
/** LUD-12 comments are short in practice; refuse an absurd service-set ceiling. */
const COMMENT_MAX = 2000

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
// URL guarding (SSRF).
//
// IMPORTANT, scope of this guard. It classifies IP *literals* and blocks
// localhost/HTTPS/credential violations. It CANNOT, on its own, stop a
// hostname that RESOLVES to a private address (e.g. an attacker A-record
// pointing at 10.0.0.5, or a rebinding TOCTOU). Browsers cannot resolve DNS,
// so a fully-safe default is impossible in the core. Server callers that
// accept untrusted addresses MUST pass `urlGuard` doing DNS resolution +
// per-address pinning, see the README recipe. Without it, treat resolution
// of attacker-controlled addresses as blind-SSRF-capable.

// Parse an IPv4 string into 4 octets, or null. Only strict dotted-decimal;
// the WHATWG URL parser normalises decimal/octal/hex forms before we see a
// hostname, so this only ever runs on already-normalised input in the guard.
function parseIpv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const octets = m.slice(1, 5).map((o) => Number(o))
  if (octets.some((o) => o > 255)) return null
  return octets
}

// Parse an IPv6 literal (already bracket-stripped, lowercased) into 8 hextets,
// handling `::` compression and a trailing embedded IPv4 dotted-quad. Returns
// null if not parseable as IPv6.
function parseIpv6(host: string): number[] | null {
  if (!host.includes(':')) return null
  let text = host
  let tailV4: number[] | null = null
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    tailV4 = parseIpv4(tail)
    if (!tailV4) return null
    text = text.slice(0, lastColon + 1) + '0:0'
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const toHextets = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = toHextets(halves[0])
  const rear = halves.length === 2 ? toHextets(halves[1]) : []
  if (head === null || rear === null) return null
  let hextets: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rear.length
    if (fill < 0) return null
    hextets = [...head, ...Array(fill).fill(0), ...rear]
  } else {
    hextets = head
  }
  if (hextets.length !== 8) return null
  if (tailV4) {
    hextets[6] = (tailV4[0] << 8) | tailV4[1]
    hextets[7] = (tailV4[2] << 8) | tailV4[3]
  }
  return hextets
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true // 192.88.99/24 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // 224/4 multicast + 240/4 reserved + broadcast
  return false
}

function isPrivateIpv6(h: number[]): boolean {
  const embedsV4 = (start: number) => isPrivateIpv4([h[start] >> 8, h[start] & 0xff, h[start + 1] >> 8, h[start + 1] & 0xff])
  // ::/96, covers ::, ::1, IPv4-compatible, ::ffff:v4 (v4-mapped), ::ffff:0:v4.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && (h[5] === 0 || h[5] === 0xffff)) {
    if (h[6] === 0 && h[7] === 0) return true // :: unspecified
    if (h[5] === 0 && h[6] === 0 && h[7] === 1) return true // ::1 loopback
    return embedsV4(6)
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) return embedsV4(6) // 64:ff9b::/96 NAT64
  if (h[0] === 0x2002) return isPrivateIpv4([h[1] >> 8, h[1] & 0xff, h[2] >> 8, h[2] & 0xff]) // 2002::/16 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true // 2001::/32 Teredo
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true // 2001:db8::/32 documentation
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true // 100::/64 discard-only
  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((h[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * True when hostname is an IP literal in a private/reserved range.
 *
 * SAFE ONLY on already-URL-normalised hostnames (what `url.hostname` yields):
 * the WHATWG URL parser canonicalises decimal/octal/hex IPv4 and compressed
 * IPv6 before a hostname exists. Do NOT call this on a raw, un-normalised
 * string (a config value, a header) and expect it to catch `0x7f000001` or
 * `2130706433`, it will not. Feed such input through `new URL()` first.
 */
export function isPrivateIpLiteral(hostname: string): boolean {
  // Drop any scoped-address zone ID (`fe80::1%lo0`): the zone is a local
  // interface selector, not part of the address class. A scope-suffixed
  // answer can reach here from a custom resolve seam (mDNS, /etc/hosts).
  const host = stripHost(hostname).split('%', 1)[0]
  const v4 = parseIpv4(host)
  if (v4) return isPrivateIpv4(v4)
  const v6 = parseIpv6(host)
  if (v6) return isPrivateIpv6(v6)
  // Fail closed: a string that looks like an IPv6 literal but does not parse
  // is treated as private rather than waved through as public.
  return host.includes(':')
}

// Strip surrounding IPv6 brackets, lowercase, and drop ALL trailing dots
// (`localhost.`, `localhost..`, `10.0.0.1.` resolve as without them; a
// non-standard resolver might accept the empty-label forms a single strip left).
function stripHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || host.includes(':')
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']
const LOCAL_EXACT = new Set(['localhost'])

/**
 * HTTPS-only, public-host, credential-free URL check. Throws LnurlError on
 * violation. Classifies IP literals only, see the module note on `urlGuard`
 * for hostnames that resolve inward.
 */
export function assertResolvableUrl(input: string | URL): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(String(input ?? ''))
  } catch {
    fail('BAD_URL', 'not a URL')
  }
  if (url.protocol !== 'https:') fail('BAD_URL', 'LNURL endpoints must use HTTPS')
  if (url.username || url.password) fail('BAD_URL', 'LNURL endpoints must not carry credentials')
  const host = stripHost(url.hostname)
  if (!host || LOCAL_EXACT.has(host) || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    fail('BAD_URL', 'LNURL endpoints must use a public host')
  }
  if (isIpLiteral(host) && isPrivateIpLiteral(host)) {
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
   * to every fetched URL after the built-in guard. REQUIRED for safe handling
   * of untrusted addresses on a server, the built-in guard classifies IP
   * literals only, not hostnames that resolve inward. See the README recipe.
   */
  urlGuard?: (url: URL) => void | Promise<void>
  /**
   * Reject an invoice whose network does not match. Defaults to 'bc'
   * (mainnet), the safe default for a money path. Pass null to accept any
   * network (dev/regtest).
   */
  network?: Bolt11Network | null
  /** Reject an already-expired invoice. Default true. */
  rejectExpired?: boolean
  /** Seconds of clock-skew slack allowed on the expiry check. Default 60. */
  expirySlackSeconds?: number
  /**
   * Verify the invoice's LUD-06 description_hash against the metadata string
   * when the invoice carries an `h` tag. Default true. This is the binding
   * that stops a service swapping the description (matters for NIP-57 zaps).
   */
  verifyDescriptionHash?: boolean
  /** Injectable clock (seconds since epoch) for the expiry check. */
  nowSeconds?: () => number
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
    if (typeof opts.amountMsats === 'number' && !Number.isInteger(opts.amountMsats)) {
      fail('BAD_AMOUNT', 'amountMsats must be a positive integer')
    }
    const v = typeof opts.amountMsats === 'bigint' ? opts.amountMsats : BigInt(opts.amountMsats)
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

/** Finite non-negative Number from untrusted JSON, else 0 (never Infinity/NaN into BigInt). */
function safeSendable(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Truncate a comment to the service's LUD-12 limit, counted in Unicode code
 * points (LUD-12 measures characters, not bytes, a byte budget over-truncates
 * multibyte text), never splitting a code point. COMMENT_MAX is a separate
 * local hard ceiling against an absurd service-set limit.
 */
function truncateComment(comment: string, commentAllowed: number): string {
  const budget = Math.min(commentAllowed, COMMENT_MAX)
  const codePoints = Array.from(comment)
  if (codePoints.length <= budget) return comment
  return codePoints.slice(0, budget).join('')
}

function readMetadata(body: Record<string, unknown>): LnurlPayMetadata {
  if (body.status === 'ERROR') fail('SERVICE_ERROR', String(body.reason ?? 'LNURL service returned an error'))
  if (body.tag !== undefined && body.tag !== 'payRequest') fail('NOT_PAYREQUEST', 'endpoint is not an LNURL-pay service')
  if (typeof body.callback !== 'string' || !body.callback) fail('NO_CALLBACK', 'LNURL-pay response has no callback URL')
  return {
    tag: String(body.tag ?? ''),
    callback: body.callback,
    minSendable: safeSendable(body.minSendable),
    maxSendable: safeSendable(body.maxSendable),
    commentAllowed: safeSendable(body.commentAllowed),
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
    maxBytes: LNURL_MAX_RESPONSE_BYTES,
  })
}

/**
 * Resolve a Lightning Address (or direct LUD-06 URL) to a bolt11 invoice for
 * an exact amount. The returned invoice has been decoded and its amount
 * verified to equal the request, a mismatched or amountless invoice throws.
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
    callback.searchParams.set('comment', truncateComment(String(opts.comment), metadata.commentAllowed))
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

  const expectNetwork = opts.network === undefined ? 'bc' : opts.network
  if (expectNetwork !== null && decoded.network !== expectNetwork) {
    fail('NETWORK_MISMATCH', `invoice is on ${decoded.network}, expected ${expectNetwork}`)
  }

  if (opts.rejectExpired !== false) {
    const nowSec = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()
    const slack = opts.expirySlackSeconds ?? 60
    if (decoded.timestamp + decoded.expirySeconds + slack < nowSec) {
      fail('INVOICE_EXPIRED', `invoice expired at ${decoded.timestamp + decoded.expirySeconds}, now ${nowSec}`)
    }
  }

  // The invoice's description_hash binds it to what was requested. NIP-57:
  // for a zap the h tag MUST be sha256(the signed zap request); LUD-06:
  // otherwise it is sha256(the metadata string). Verifying the wrong side
  // would both reject compliant zaps and wave through a zap invoice with no
  // commitment at all.
  if (opts.verifyDescriptionHash !== false) {
    if (zap) {
      const expected = bytesToHex(sha256(new TextEncoder().encode(String(opts.nostr))))
      if (!decoded.descriptionHashHex || expected !== decoded.descriptionHashHex.toLowerCase()) {
        fail('DESCRIPTION_HASH_MISMATCH', 'zap invoice description_hash does not commit to the zap request')
      }
    } else if (decoded.descriptionHashHex && metadata.metadata) {
      const expected = bytesToHex(sha256(new TextEncoder().encode(metadata.metadata)))
      if (expected !== decoded.descriptionHashHex.toLowerCase()) {
        fail('DESCRIPTION_HASH_MISMATCH', 'invoice description_hash does not match the LNURL metadata')
      }
    }
  }

  // LUD-21 verify URL: bind it to the callback origin and guard it, so a
  // hostile service cannot stash an internal-facing URL for later.
  let verifyUrl: string | null = null
  const verify = invoiceBody.verify
  if (typeof verify === 'string' && verify) {
    try {
      const checked = assertResolvableUrl(verify)
      if (checked.origin === callback.origin) verifyUrl = checked.toString()
    } catch {
      verifyUrl = null
    }
  }

  return {
    address,
    amountMsats: msats,
    amountSats: msats % 1000n === 0n ? Number(msats / 1000n) : null,
    bolt11,
    paymentHashHex: decoded.paymentHashHex,
    verifyUrl,
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
  maxEntries = 1000,
  now = () => Date.now(),
}: Pick<ResolveLnurlPayOptions, 'fetchImpl' | 'timeoutMs' | 'urlGuard'> & {
  cacheTtlMs?: number
  /** Cap the cache so untrusted probe volume cannot grow it without bound. */
  maxEntries?: number
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
      // FIFO eviction once full, Map preserves insertion order.
      if (!cache.has(parsed.address) && cache.size >= maxEntries) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
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
