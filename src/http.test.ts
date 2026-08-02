import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS, fetchJson, HttpError, ResponseTooLargeError } from './http.js'

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

// A Response whose body streams `chunks` (Uint8Array) and reports headers.
function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let cancelled = false
  let i = 0
  const body = {
    getReader() {
      return {
        async read() {
          if (cancelled || i >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[i++] }
        },
        async cancel() {
          cancelled = true
        },
      }
    },
  }
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body,
    json: async () => JSON.parse(new TextDecoder().decode(chunks[0] ?? new Uint8Array())),
  } as unknown as Response
}

describe('fetchJson', () => {
  it('returns parsed JSON and sends an accept header', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const result = await fetchJson<{ hello: string }>('https://example.com/x', {
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init! }
        return okResponse({ hello: 'world' })
      },
    })
    expect(result).toEqual({ hello: 'world' })
    expect(seen!.url).toBe('https://example.com/x')
    expect((seen!.init.headers as Record<string, string>).accept).toBe('application/json')
    expect(seen!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('serialises object bodies and sets content-type once', async () => {
    let init: RequestInit | undefined
    await fetchJson('https://example.com', {
      method: 'POST',
      body: { a: 1 },
      fetchImpl: async (_u, i) => {
        init = i
        return okResponse({})
      },
    })
    expect(init!.body).toBe('{"a":1}')
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json')

    await fetchJson('https://example.com', {
      method: 'POST',
      body: 'raw',
      headers: { 'Content-Type': 'text/plain' },
      fetchImpl: async (_u, i) => {
        init = i
        return okResponse({})
      },
    })
    expect(init!.body).toBe('raw')
    const headers = init!.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('text/plain')
    expect(headers['content-type']).toBeUndefined()
  })

  it('throws HttpError with the host on non-2xx', async () => {
    await expect(
      fetchJson('https://pay.example.net/lnurlp/bob', {
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response,
      }),
    ).rejects.toThrowError(new HttpError(404, 'pay.example.net'))
  })

  it('times out with the host in the message', async () => {
    await expect(
      fetchJson('https://slow.example.org/api', {
        timeoutMs: 20,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            )
          }),
      }),
    ).rejects.toThrow(/slow\.example\.org timed out after 20ms/)
  })

  it('exposes a sane default timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000)
  })

  it('caps the response body and aborts an oversized stream mid-flight', async () => {
    const enc = new TextEncoder()
    const big = [enc.encode('{"a":"'), enc.encode('x'.repeat(1000)), enc.encode('"}')]
    await expect(
      fetchJson('https://svc.example.com', { maxBytes: 100, fetchImpl: async () => streamResponse(big) }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
    // A body within budget streams and parses fine.
    const small = [new TextEncoder().encode('{"ok":true}')]
    expect(await fetchJson('https://svc.example.com', { maxBytes: 1000, fetchImpl: async () => streamResponse(small) })).toEqual({ ok: true })
  })

  it('rejects on an oversized content-length before reading the body', async () => {
    let read = false
    const resp = {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '999999' : null) },
      body: { getReader: () => ({ read: async () => ((read = true), { done: true, value: undefined }), cancel: async () => {} }) },
      json: async () => ({}),
    } as unknown as Response
    await expect(
      fetchJson('https://svc.example.com', { maxBytes: 1000, fetchImpl: async () => resp }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
    expect(read).toBe(false)
  })

  it('defaults redirect to manual (SSRF-safe) and lets callers opt into follow', async () => {
    let seen: RequestRedirect | undefined
    const capture = (async (_u: unknown, init: RequestInit) => {
      seen = init.redirect
      return okResponse({})
    }) as unknown as typeof fetch
    await fetchJson('https://svc.example.com', { fetchImpl: capture })
    expect(seen).toBe('manual')
    await fetchJson('https://svc.example.com', { redirect: 'follow', fetchImpl: capture })
    expect(seen).toBe('follow')
  })
})
