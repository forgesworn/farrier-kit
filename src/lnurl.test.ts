import { describe, expect, it } from 'vitest'
import { computePaymentHash, generatePreimage } from './preimage.js'
import {
  assertResolvableUrl,
  createCapabilityProbe,
  isLightningAddress,
  isPrivateIpLiteral,
  lnurlPayUrl,
  LnurlError,
  parseLightningAddress,
  resolveLnurlPay,
  verifyLud21,
} from './lnurl.js'
import { buildInvoice, tag, words52 } from './test-fixtures.js'

const HASH = 'a1'.repeat(32)
// 250 000 sats exactly, carrying the payment hash the tests expect.
const INVOICE_250K = buildInvoice('lnbc2500u', [tag(1, words52(HASH))])

interface Route {
  body: unknown
  status?: number
}
/** Fake fetch keyed by URL prefix; records every request it serves. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = []
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url)
    calls.push(u)
    const route = Object.entries(routes).find(([prefix]) => u.startsWith(prefix))?.[1]
    if (!route) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
    } as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

const METADATA = {
  tag: 'payRequest',
  callback: 'https://pay.example.com/cb',
  minSendable: 1000,
  maxSendable: 100_000_000_000,
  commentAllowed: 20,
  metadata: '[["text/plain","tip"]]',
}

describe('Lightning Address parsing', () => {
  it('accepts and canonicalises name@domain (LUD-16: lowercase both halves)', () => {
    expect(parseLightningAddress('Alice@Wallet.Example.COM ')).toEqual({
      address: 'alice@wallet.example.com',
      name: 'alice',
      domain: 'wallet.example.com',
    })
    expect(isLightningAddress('2547001122@bitcoin.co.ke')).toBe(true)
    expect(lnurlPayUrl({ name: 'a b', domain: 'x.co' })).toBe('https://x.co/.well-known/lnurlp/a%20b')
  })

  it('rejects non-addresses and local domains', () => {
    for (const bad of ['nope', 'a@b', 'a b@x.com', 'alice@localhost', 'alice@dev.local', '']) {
      expect(isLightningAddress(bad) && !/local/.test(bad), bad).toBe(false)
      expect(() => parseLightningAddress(bad)).toThrow(LnurlError)
    }
  })
})

describe('URL guard (SSRF)', () => {
  it('requires HTTPS and public hosts', () => {
    expect(() => assertResolvableUrl('http://pay.example.com/x')).toThrow(/HTTPS/)
    expect(() => assertResolvableUrl('https://localhost/x')).toThrow(/public host/)
    expect(() => assertResolvableUrl('https://svc.internal.local/x')).toThrow(/public host/)
    expect(() => assertResolvableUrl('not a url')).toThrow(/not a URL/)
    expect(assertResolvableUrl('https://pay.example.com/x')).toBeInstanceOf(URL)
  })

  it('classifies private and reserved IP literals', () => {
    for (const priv of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.9.9',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '999.1.1.1',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isPrivateIpLiteral(priv), priv).toBe(true)
    }
    for (const pub of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2600:9000::1', '::ffff:8.8.8.8']) {
      expect(isPrivateIpLiteral(pub), pub).toBe(false)
    }
    expect(() => assertResolvableUrl('https://192.168.1.1/x')).toThrow(/private or reserved/)
    expect(() => assertResolvableUrl('https://[::1]/x')).toThrow(/private or reserved/)
  })
})

describe('resolveLnurlPay', () => {
  it('resolves an address to a decoded, amount-verified invoice', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://wallet.example.com/.well-known/lnurlp/alice': { body: { ...METADATA, allowsNostr: false } },
      'https://pay.example.com/cb': { body: { pr: INVOICE_250K, verify: 'https://pay.example.com/v/1' } },
    })
    const result = await resolveLnurlPay({
      address: 'alice@wallet.example.com',
      amountSats: 250_000,
      comment: 'thanks for the ride, this is far too long',
      fetchImpl,
    })
    expect(result.paymentHashHex).toBe(HASH)
    expect(result.amountMsats).toBe(250_000_000n)
    expect(result.amountSats).toBe(250_000)
    expect(result.bolt11).toBe(INVOICE_250K)
    expect(result.verifyUrl).toBe('https://pay.example.com/v/1')
    expect(result.zap).toBe(false)
    const cb = new URL(calls[1])
    expect(cb.searchParams.get('amount')).toBe('250000000')
    expect(cb.searchParams.get('comment')).toBe('thanks for the ride,') // truncated to 20
  })

  it('attaches a zap request instead of a comment when the service allows it', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': {
        body: { ...METADATA, allowsNostr: true, nostrPubkey: 'ab'.repeat(32) },
      },
      'https://pay.example.com/cb': { body: { pr: INVOICE_250K } },
    })
    const result = await resolveLnurlPay({
      address: 'bob@w.example.net',
      amountSats: 250_000,
      comment: 'ignored',
      nostr: '{"kind":9734}',
      fetchImpl,
    })
    expect(result.zap).toBe(true)
    const cb = new URL(calls[1])
    expect(cb.searchParams.get('nostr')).toBe('{"kind":9734}')
    expect(cb.searchParams.get('comment')).toBeNull()
  })

  it('enforces the sendable range', async () => {
    const { fetchImpl } = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': {
        body: { ...METADATA, minSendable: 10_000, maxSendable: 20_000 },
      },
    })
    await expect(
      resolveLnurlPay({ address: 'bob@w.example.net', amountSats: 5, fetchImpl }),
    ).rejects.toThrow(/minimum is 10 sats/)
    await expect(
      resolveLnurlPay({ address: 'bob@w.example.net', amountSats: 25, fetchImpl }),
    ).rejects.toThrow(/maximum is 20 sats/)
  })

  it('rejects a mismatched or amountless invoice (the check neither seed had)', async () => {
    const wrongAmount = buildInvoice('lnbc2600u', [tag(1, words52(HASH))])
    const amountless = buildInvoice('lnbc', [tag(1, words52(HASH))])
    for (const [pr, re] of [
      [wrongAmount, /invoice is for 260000000 msat, requested 250000000 msat/],
      [amountless, /amountless invoice/],
      ['junk', /undecodable invoice/],
    ] as const) {
      const { fetchImpl } = fakeFetch({
        'https://w.example.net/.well-known/lnurlp/bob': { body: METADATA },
        'https://pay.example.com/cb': { body: { pr } },
      })
      await expect(
        resolveLnurlPay({ address: 'bob@w.example.net', amountSats: 250_000, fetchImpl }),
      ).rejects.toThrow(re)
    }
  })

  it('surfaces service errors and refuses non-payRequest endpoints', async () => {
    const err = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': { body: { status: 'ERROR', reason: 'no such user' } },
    })
    await expect(
      resolveLnurlPay({ address: 'bob@w.example.net', amountSats: 10, fetchImpl: err.fetchImpl }),
    ).rejects.toThrow(/no such user/)

    const withdraw = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': { body: { tag: 'withdrawRequest', callback: 'https://x.co' } },
    })
    await expect(
      resolveLnurlPay({ address: 'bob@w.example.net', amountSats: 10, fetchImpl: withdraw.fetchImpl }),
    ).rejects.toThrow(/not an LNURL-pay service/)
  })

  it('refuses an insecure callback and runs the injectable urlGuard on every URL', async () => {
    const insecure = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': {
        body: { ...METADATA, callback: 'http://pay.example.com/cb' },
      },
    })
    await expect(
      resolveLnurlPay({ address: 'bob@w.example.net', amountSats: 10, fetchImpl: insecure.fetchImpl }),
    ).rejects.toThrow(/HTTPS/)

    const guarded: string[] = []
    const ok = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': { body: METADATA },
      'https://pay.example.com/cb': { body: { pr: INVOICE_250K } },
    })
    await resolveLnurlPay({
      address: 'bob@w.example.net',
      amountSats: 250_000,
      fetchImpl: ok.fetchImpl,
      urlGuard: (u) => {
        guarded.push(u.hostname)
      },
    })
    expect(guarded).toEqual(['w.example.net', 'pay.example.com'])
  })

  it('validates amounts before any network traffic', async () => {
    const { fetchImpl, calls } = fakeFetch({})
    for (const bad of [{ amountSats: 0 }, { amountSats: 1.5 }, { amountMsats: -5n }, {}]) {
      await expect(resolveLnurlPay({ address: 'a@b.co', fetchImpl, ...bad })).rejects.toThrow(LnurlError)
    }
    expect(calls).toEqual([])
  })
})

describe('verifyLud21', () => {
  it('cryptographically verifies a returned preimage', async () => {
    const preimage = generatePreimage()
    const paymentHashHex = computePaymentHash(preimage)
    const { fetchImpl } = fakeFetch({
      'https://pay.example.com/v/1': { body: { status: 'OK', settled: true, preimage } },
    })
    const result = await verifyLud21({ verifyUrl: 'https://pay.example.com/v/1', paymentHashHex, fetchImpl })
    expect(result).toEqual({ settled: true, preimage, verified: true })
  })

  it("settled without a matching preimage is the service's word, not proof", async () => {
    const { fetchImpl } = fakeFetch({
      'https://pay.example.com/v/1': { body: { status: 'OK', settled: true } },
      'https://pay.example.com/v/2': { body: { status: 'OK', settled: true, preimage: 'ff'.repeat(32) } },
      'https://pay.example.com/v/3': { body: { status: 'OK', settled: false } },
    })
    const hash = computePaymentHash(generatePreimage())
    expect(await verifyLud21({ verifyUrl: 'https://pay.example.com/v/1', paymentHashHex: hash, fetchImpl })).toEqual({
      settled: true,
      preimage: null,
      verified: false,
    })
    const wrong = await verifyLud21({ verifyUrl: 'https://pay.example.com/v/2', paymentHashHex: hash, fetchImpl })
    expect(wrong.settled).toBe(true)
    expect(wrong.verified).toBe(false)
    expect((await verifyLud21({ verifyUrl: 'https://pay.example.com/v/3', paymentHashHex: hash, fetchImpl })).settled).toBe(false)
  })
})

describe('createCapabilityProbe', () => {
  it('caches per address within the TTL and refreshes after it', async () => {
    let clock = 0
    const { fetchImpl, calls } = fakeFetch({
      'https://w.example.net/.well-known/lnurlp/bob': {
        body: { ...METADATA, allowsNostr: true, nostrPubkey: 'ab'.repeat(32) },
      },
    })
    const probe = createCapabilityProbe({ fetchImpl, cacheTtlMs: 1000, now: () => clock })
    const first = await probe.probe('bob@w.example.net')
    expect(first).toMatchObject({ ok: true, commentAllowed: 20, allowsNostr: true })
    await probe.probe('Bob@W.EXAMPLE.NET') // same canonical address -> cache hit
    expect(calls).toHaveLength(1)
    clock = 1500
    await probe.probe('bob@w.example.net')
    expect(calls).toHaveLength(2)
    probe.invalidate('bob@w.example.net')
    await probe.probe('bob@w.example.net')
    expect(calls).toHaveLength(3)
  })

  it('caches failures too, with the reason', async () => {
    const { fetchImpl, calls } = fakeFetch({})
    const probe = createCapabilityProbe({ fetchImpl, now: () => 0 })
    const result = await probe.probe('ghost@w.example.net')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/404/)
    await probe.probe('ghost@w.example.net')
    expect(calls).toHaveLength(1)
  })
})
