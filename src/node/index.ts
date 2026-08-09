// Node-only. A pinned-connection fetch for resolving LNURL and Lightning
// Address endpoints against UNTRUSTED hosts.
//
// The browser-safe core cannot resolve DNS, so its SSRF guard classifies IP
// literals only. A server that resolves an attacker-supplied hostname needs
// more, for two reasons:
//
//   1. The name might simply resolve to a private address (an A record
//      pointing at 10.0.0.5, say), which a literal check never sees.
//   2. It might resolve public when you check and private when you connect.
//      That is DNS rebinding: a check-then-fetch has a window between the two
//      lookups where the answer can change.
//
// This closes both. It resolves the hostname once, rejects the request if any
// answer is private or reserved, and then connects to the one approved address
// by overriding the socket's own `lookup`. Because the socket uses the address
// we already validated, there is no second resolution and no window. The TLS
// SNI and the Host header stay set to the original hostname, so certificate
// validation and virtual hosting still work.
//
// Pass the returned function as `fetchImpl` to resolveLnurlPay, verifyLud21 or
// createCapabilityProbe. It is a drop-in for the global fetch for those calls,
// and it replaces the check-then-fetch `urlGuard` recipe, which cannot close
// the rebinding window on its own.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { isPrivateIpLiteral } from '../lnurl.js'

export class PinnedFetchError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PinnedFetchError'
    this.code = code
  }
}

/** Node's low-level request signature, shared by http and https. Testing seam. */
type NodeRequest = typeof httpRequest

export interface CreatePinnedFetchOptions {
  /**
   * Permit private or reserved targets. Default false. Turn this on ONLY for
   * local development against regtest or localhost, never for untrusted
   * addresses, it disables the whole point of the adapter.
   */
  allowPrivate?: boolean
  /**
   * Permit plaintext http: URLs. Default false: the pin only proves you are
   * talking to the address you resolved, and on cleartext an on-path attacker
   * can answer for it anyway, so HTTP gets a false sense of endpoint
   * authenticity. Turn this on ONLY for local development, beside
   * `allowPrivate`, never for untrusted addresses.
   */
  allowHttp?: boolean
  /**
   * Resolve a hostname to its candidate addresses. Defaults to node:dns
   * lookup over all records. A test seam, and an escape hatch for a custom
   * resolver (DoH, a fixed allowlist).
   */
  resolve?: (hostname: string) => Promise<LookupAddress[]>
  /**
   * Classify a resolved address literal as blocked. Defaults to the same
   * private/reserved classifier the core guard uses.
   */
  isBlockedAddress?: (address: string) => boolean
  /**
   * Low-level request implementation. Defaults to node:http / node:https by
   * protocol. Testing seam, or a hook for a custom agent.
   */
  requestImpl?: NodeRequest
}

/** Statuses that forbid a response body per fetch semantics. */
const NULL_BODY_STATUS = new Set([204, 205, 304])

function defaultResolve(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses)
    })
  })
}

function toHeaderObject(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!init) return out
  if (init instanceof Headers) init.forEach((value, key) => (out[key] = value))
  else if (Array.isArray(init)) for (const [key, value] of init) out[key] = value
  else for (const [key, value] of Object.entries(init)) out[key] = String(value)
  return out
}

function bodyToPayload(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return body
  return String(body)
}

// Resolve once, reject the whole request if ANY answer is private or reserved,
// then pin to the first. Rejecting on any private answer is the conservative
// stance: it denies a resolver that mixes a public address in with a private
// one to slip past a first-match check.
async function resolvePinned(
  hostname: string,
  opts: { resolve: (h: string) => Promise<LookupAddress[]>; allowPrivate: boolean; isBlocked: (a: string) => boolean },
): Promise<LookupAddress> {
  let addresses: LookupAddress[]
  try {
    addresses = await opts.resolve(hostname)
  } catch (err) {
    throw new PinnedFetchError('DNS_ERROR', `could not resolve ${hostname}: ${(err as Error).message}`)
  }
  if (!addresses || addresses.length === 0) {
    throw new PinnedFetchError('NO_ADDRESS', `no DNS answer for ${hostname}`)
  }
  if (!opts.allowPrivate) {
    for (const answer of addresses) {
      if (opts.isBlocked(answer.address)) {
        throw new PinnedFetchError(
          'PRIVATE_ADDRESS',
          `${hostname} resolves to a private or reserved address (${answer.address})`,
        )
      }
    }
  }
  return addresses[0]
}

function toResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 502
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, String(value))
  }
  if (NULL_BODY_STATUS.has(status)) {
    res.resume() // drain so the socket is released
    return new Response(null, { status, statusText: res.statusMessage, headers })
  }
  const stream = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
  return new Response(stream, { status, statusText: res.statusMessage, headers })
}

/**
 * Build a fetch that resolves DNS once, refuses any private or reserved
 * answer, and pins the connection to the approved address while keeping the
 * TLS SNI and Host header on the original hostname. Node-only.
 *
 * It never follows redirects. A 3xx is returned as-is (a non-ok response),
 * so a hostile service cannot 3xx-bounce the request inward.
 */
export function createPinnedFetch(options: CreatePinnedFetchOptions = {}): typeof fetch {
  const resolve = options.resolve ?? defaultResolve
  const allowPrivate = options.allowPrivate ?? false
  const allowHttp = options.allowHttp ?? false
  const isBlocked = options.isBlockedAddress ?? isPrivateIpLiteral

  const pinnedFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : (input as URL | Request).toString())
    if (url.protocol === 'http:' && !allowHttp) {
      throw new PinnedFetchError('BAD_PROTOCOL', 'plaintext http: is refused; pass allowHttp for local development only')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PinnedFetchError('BAD_PROTOCOL', `unsupported protocol ${url.protocol}`)
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const pinned = await resolvePinned(hostname, { resolve, allowPrivate, isBlocked })

    // Hand the socket back the address we already validated. Node does not
    // resolve again, so what we checked is exactly what we connect to.
    const pinnedLookup = (
      _host: string,
      lookupOptions: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ): void => {
      const wantsAll = typeof lookupOptions === 'object' && lookupOptions !== null && (lookupOptions as { all?: boolean }).all
      if (wantsAll) callback(null, [{ address: pinned.address, family: pinned.family }])
      else callback(null, pinned.address, pinned.family)
    }

    const requestFn = options.requestImpl ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
    const requestOptions: RequestOptions = {
      method: init.method ?? 'GET',
      headers: toHeaderObject(init.headers),
      // The pin. host and servername stay derived from the URL hostname, so
      // SNI and certificate validation target the real name, not the IP.
      lookup: pinnedLookup as RequestOptions['lookup'],
      signal: (init.signal ?? undefined) as RequestOptions['signal'],
    }
    const payload = bodyToPayload(init.body)

    return await new Promise<Response>((resolveResponse, reject) => {
      const req = requestFn(url, requestOptions, (res) => resolveResponse(toResponse(res)))
      req.on('error', reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  return pinnedFetch as unknown as typeof fetch
}
