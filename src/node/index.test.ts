import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchJson } from '../http.js'
import { resolveLnurlPay, verifyLud21 } from '../lnurl.js'
import { computePaymentHash, generatePreimage } from '../preimage.js'
import { buildInvoice, tag, words52 } from '../test-fixtures.js'
import { createPinnedFetch, PinnedFetchError } from './index.js'

const HASH = 'a1'.repeat(32)
const INVOICE_TIME = 1_700_000_000
const INVOICE_250K = buildInvoice('lnbc2500u', [tag(1, words52(HASH))])

// A fake IncomingMessage: a Readable streaming `body`, plus the status and
// headers fields toResponse reads.
function fakeRes(body: string, { status = 200, statusMessage = 'OK', headers = {} as Record<string, string> } = {}): IncomingMessage {
  const res = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  ;(res as unknown as { statusCode: number }).statusCode = status
  ;(res as unknown as { statusMessage: string }).statusMessage = statusMessage
  ;(res as unknown as { headers: Record<string, string> }).headers = { 'content-type': 'application/json', ...headers }
  return res
}

interface Captured {
  url: URL
  options: Record<string, unknown>
  written: string[]
}

// A requestImpl seam: captures what the adapter passed, drives the callback
// with a canned response, and lets a test resolve which body to serve by path.
function fakeRequest(route: (url: URL) => IncomingMessage) {
  const calls: Captured[] = []
  const impl = ((url: URL, options: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    const cap: Captured = { url: new URL(String(url)), options, written: [] }
    calls.push(cap)
    const req = {
      on() {},
      write(chunk: unknown) {
        cap.written.push(String(chunk))
      },
      end() {
        queueMicrotask(() => cb(route(cap.url)))
      },
      destroy() {},
    }
    return req as never
  }) as unknown as CreatePinnedFetchRequestImpl
  return { impl, calls }
}
type CreatePinnedFetchRequestImpl = NonNullable<Parameters<typeof createPinnedFetch>[0]>['requestImpl']

const PUBLIC_V4 = [{ address: '203.0.113.9', family: 4 }] // documentation range is blocked
const REAL_PUBLIC_V4 = [{ address: '1.1.1.1', family: 4 }]

describe('createPinnedFetch address policy', () => {
  it('rejects a hostname that resolves to a private address', async () => {
    const { impl, calls } = fakeRequest(() => fakeRes('{}'))
    const f = createPinnedFetch({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], requestImpl: impl })
    await expect(f('https://pay.example.com/x')).rejects.toBeInstanceOf(PinnedFetchError)
    await expect(f('https://pay.example.com/x')).rejects.toThrow(/private or reserved/)
    expect(calls).toHaveLength(0) // never connected
  })

  it('rejects when ANY answer in a mixed set is private', async () => {
    const f = createPinnedFetch({
      resolve: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    })
    await expect(f('https://pay.example.com/x')).rejects.toThrow(/private or reserved/)
  })

  it('rejects private and reserved literals (v4 and v6)', async () => {
    for (const addr of ['169.254.169.254', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
      const family = addr.includes(':') ? 6 : 4
      const f = createPinnedFetch({ resolve: async () => [{ address: addr, family }] })
      await expect(f('https://pay.example.com/x'), addr).rejects.toThrow(/private or reserved/)
    }
  })

  it('a rebinding second answer cannot replace the pinned public address', async () => {
    let calls = 0
    const resolve = async () => {
      calls += 1
      // First (and only) resolution is public. A rebinding resolver would hand
      // back 127.0.0.1 on a second call; the adapter must never make one.
      return calls === 1 ? REAL_PUBLIC_V4 : [{ address: '127.0.0.1', family: 4 }]
    }
    const { impl, calls: reqCalls } = fakeRequest(() => fakeRes('{"ok":true}'))
    const f = createPinnedFetch({ resolve, requestImpl: impl })
    expect(await fetchJson('https://pay.example.com/x', { fetchImpl: f })).toEqual({ ok: true })
    expect(calls).toBe(1) // resolved exactly once
    // The lookup handed to the socket returns the validated public address.
    const lookup = reqCalls[0].options.lookup as (h: string, o: unknown, cb: (e: unknown, a: string, f: number) => void) => void
    let pinned = ''
    lookup('pay.example.com', {}, (_e, a) => (pinned = a))
    expect(pinned).toBe('1.1.1.1')
  })

  it('allowPrivate opts into loopback for local development', async () => {
    const { impl } = fakeRequest(() => fakeRes('{"dev":true}'))
    const f = createPinnedFetch({ allowPrivate: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], requestImpl: impl })
    expect(await fetchJson('https://localdev.example.com/x', { fetchImpl: f })).toEqual({ dev: true })
  })

  it('rejects a scope-suffixed link-local answer from a custom resolver', async () => {
    // DNS wire format cannot carry a zone ID, but mDNS, /etc/hosts or a
    // consumer-supplied resolve seam can return one. Classification must not
    // fail open on it.
    const { impl, calls } = fakeRequest(() => fakeRes('{}'))
    const f = createPinnedFetch({ resolve: async () => [{ address: 'fe80::1%lo0', family: 6 }], requestImpl: impl })
    await expect(f('https://pay.example.com/x')).rejects.toThrow(/private or reserved/)
    expect(calls).toHaveLength(0)
  })

  it('refuses plaintext http: by default and honours the allowHttp escape hatch', async () => {
    const { impl, calls } = fakeRequest(() => fakeRes('{"ok":true}'))
    const strict = createPinnedFetch({ resolve: async () => REAL_PUBLIC_V4, requestImpl: impl })
    await expect(strict('http://pay.example.com/x')).rejects.toThrow(/plaintext http:/)
    expect(calls).toHaveLength(0)
    const dev = createPinnedFetch({ allowHttp: true, resolve: async () => REAL_PUBLIC_V4, requestImpl: impl })
    expect(await fetchJson('http://pay.example.com/x', { fetchImpl: dev })).toEqual({ ok: true })
  })

  it('refuses a non-http(s) protocol', async () => {
    const f = createPinnedFetch({ resolve: async () => REAL_PUBLIC_V4 })
    await expect(f('ftp://pay.example.com/x')).rejects.toThrow(/unsupported protocol/)
  })

  it('surfaces a DNS failure and an empty answer as PinnedFetchError', async () => {
    const boom = createPinnedFetch({ resolve: async () => { throw new Error('SERVFAIL') } })
    await expect(boom('https://pay.example.com/x')).rejects.toThrow(/could not resolve/)
    const empty = createPinnedFetch({ resolve: async () => [] })
    await expect(empty('https://pay.example.com/x')).rejects.toThrow(/no DNS answer/)
  })
})

describe('createPinnedFetch connection semantics', () => {
  it('pins the socket to the resolved address and keeps host/SNI on the hostname', async () => {
    const { impl, calls } = fakeRequest(() => fakeRes('{"ok":true}'))
    const f = createPinnedFetch({ resolve: async () => PUBLIC_V4, allowPrivate: true, requestImpl: impl })
    await fetchJson('https://pay.example.com/lnurlp/alice', { fetchImpl: f })
    const cap = calls[0]
    // host/servername are NOT set in options, so node derives both from the URL
    // hostname: SNI and certificate validation target pay.example.com, not the IP.
    expect(cap.options.host).toBeUndefined()
    expect(cap.options.servername).toBeUndefined()
    expect(cap.url.hostname).toBe('pay.example.com')
    // The lookup pins the connection to the validated address.
    const lookup = cap.options.lookup as (h: string, o: unknown, cb: (e: unknown, a: string, f: number) => void) => void
    let addr = ''
    let fam = 0
    lookup('pay.example.com', {}, (_e, a, ff) => ((addr = a), (fam = ff)))
    expect(addr).toBe('203.0.113.9')
    expect(fam).toBe(4)
  })

  it('passes the IPv6 family through the pin', async () => {
    const { impl, calls } = fakeRequest(() => fakeRes('{"ok":true}'))
    const f = createPinnedFetch({ resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }], requestImpl: impl })
    await fetchJson('https://pay.example.com/x', { fetchImpl: f })
    const lookup = calls[0].options.lookup as (h: string, o: unknown, cb: (e: unknown, a: string, f: number) => void) => void
    let addr = ''
    let fam = 0
    lookup('pay.example.com', { all: false }, (_e, a, ff) => ((addr = a), (fam = ff)))
    expect(addr).toBe('2606:4700:4700::1111')
    expect(fam).toBe(6)
    // With all:true the socket expects an array; the adapter honours that shape.
    let all: unknown
    ;(calls[0].options.lookup as (h: string, o: unknown, cb: (e: unknown, a: unknown) => void) => void)('pay.example.com', { all: true }, (_e, a) => (all = a))
    expect(all).toEqual([{ address: '2606:4700:4700::1111', family: 6 }])
  })

  it('preserves method, headers, body and the abort signal', async () => {
    const { impl, calls } = fakeRequest(() => fakeRes('{"ok":true}'))
    const f = createPinnedFetch({ resolve: async () => PUBLIC_V4, allowPrivate: true, requestImpl: impl })
    const controller = new AbortController()
    await f('https://pay.example.com/cb', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trott': '1' },
      body: '{"amount":1}',
      signal: controller.signal,
    })
    const cap = calls[0]
    expect(cap.options.method).toBe('POST')
    expect((cap.options.headers as Record<string, string>)['x-trott']).toBe('1')
    expect(cap.options.signal).toBe(controller.signal)
    expect(cap.written.join('')).toBe('{"amount":1}')
  })

  it('never follows redirects: a 3xx returns as a non-ok response', async () => {
    const { impl } = fakeRequest(() => fakeRes('{}', { status: 302, statusMessage: 'Found', headers: { location: 'https://10.0.0.1/' } }))
    const f = createPinnedFetch({ resolve: async () => PUBLIC_V4, allowPrivate: true, requestImpl: impl })
    // fetchJson treats a 3xx as non-ok and throws, so the inward Location is never fetched.
    await expect(fetchJson('https://pay.example.com/x', { fetchImpl: f })).rejects.toThrow(/HTTP 302/)
  })
})

describe('createPinnedFetch over a real loopback socket', () => {
  let server: Server | undefined
  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('connects to the pinned address and preserves the Host header end to end', async () => {
    let seenHost = ''
    server = createServer((req, res) => {
      seenHost = req.headers.host ?? ''
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ pong: true }))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server!.address() as AddressInfo).port
    // The URL host is a name that would never resolve to loopback on its own;
    // the pin sends the connection to 127.0.0.1 while the Host header stays the name.
    const f = createPinnedFetch({ allowPrivate: true, allowHttp: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    const body = await fetchJson<{ pong: boolean }>(`http://pinned.example.test:${port}/x`, { fetchImpl: f })
    expect(body).toEqual({ pong: true })
    expect(seenHost).toBe(`pinned.example.test:${port}`)
  })
})

describe('resolveLnurlPay and verifyLud21 consume createPinnedFetch', () => {
  it('resolves an address to an invoice through the pinned transport', async () => {
    const { impl } = fakeRequest((url) => {
      if (url.pathname.includes('/.well-known/lnurlp/')) {
        return fakeRes(JSON.stringify({ tag: 'payRequest', callback: 'https://pay.example.com/cb', minSendable: 1000, maxSendable: 100_000_000_000, metadata: '[["text/plain","tip"]]' }))
      }
      return fakeRes(JSON.stringify({ pr: INVOICE_250K, verify: 'https://pay.example.com/v/1' }))
    })
    const f = createPinnedFetch({ resolve: async () => PUBLIC_V4, allowPrivate: true, requestImpl: impl })
    const result = await resolveLnurlPay({
      address: 'alice@wallet.example.com',
      amountSats: 250_000,
      fetchImpl: f,
      nowSeconds: () => INVOICE_TIME + 100,
    })
    expect(result.paymentHashHex).toBe(HASH)
    expect(result.verifyUrl).toBe('https://pay.example.com/v/1')
  })

  it('verifies a LUD-21 preimage through the pinned transport', async () => {
    const preimage = generatePreimage()
    const paymentHashHex = computePaymentHash(preimage)
    const { impl } = fakeRequest(() => fakeRes(JSON.stringify({ status: 'OK', settled: true, preimage })))
    const f = createPinnedFetch({ resolve: async () => PUBLIC_V4, allowPrivate: true, requestImpl: impl })
    const result = await verifyLud21({ verifyUrl: 'https://pay.example.com/v/1', paymentHashHex, fetchImpl: f })
    expect(result).toEqual({ settled: true, preimage, verified: true })
  })
})
