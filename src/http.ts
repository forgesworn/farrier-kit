// fetch with a hard timeout and JSON handling. Some fetch implementations
// (node-fetch@2 among them) have NO default timeout — a hung upstream would
// otherwise hold its caller open forever.

export const DEFAULT_TIMEOUT_MS = 8000
/** Default response ceiling for the general util: generous for JSON, still bounds OOM. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

export interface FetchJsonOptions {
  /** Injectable fetch (tests, node-fetch, undici). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  method?: string
  headers?: Record<string, string>
  /** Objects are JSON-serialised and content-type set, strings pass through. */
  body?: unknown
  /**
   * Redirect handling. Defaults to 'manual' — a safe default for a payments
   * util, so a public host cannot 3xx-bounce the request inward. Pass 'follow'
   * to opt into redirects.
   */
  redirect?: RequestRedirect
  /** Reject a response body larger than this many bytes. Defaults to DEFAULT_MAX_BYTES. */
  maxBytes?: number
}

export class ResponseTooLargeError extends Error {
  constructor(host: string, maxBytes: number) {
    super(`Response from ${host} exceeded ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

// Read a response body with a hard byte budget, streaming when the runtime
// exposes a ReadableStream so an oversized body is aborted mid-flight rather
// than fully buffered. Falls back to response.json() for test doubles and
// runtimes without a stream body.
async function readCappedJson<T>(response: Response, maxBytes: number, host: string): Promise<T> {
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw new ResponseTooLargeError(host, maxBytes)
  }
  const body = response.body as ReadableStream<Uint8Array> | null | undefined
  if (!body || typeof body.getReader !== 'function') {
    return (await response.json()) as T
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ResponseTooLargeError(host, maxBytes)
      }
      chunks.push(value)
    }
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return JSON.parse(new TextDecoder().decode(buf)) as T
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export class HttpError extends Error {
  status: number
  constructor(status: number, host: string) {
    super(`HTTP ${status} from ${host}`)
    this.name = 'HttpError'
    this.status = status
  }
}

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available; pass fetchImpl')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Node returns a Timeout with unref; browsers return a number. Never keep
  // the process alive just for our deadline.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) }
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: controller.signal,
      redirect: options.redirect ?? 'manual',
    }
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')
      if (!hasContentType) headers['content-type'] = 'application/json'
    }
    const response = await fetchImpl(url, init)
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {}) // don't leave the socket half-read
      throw new HttpError(response.status, hostOf(url))
    }
    return await readCappedJson<T>(response, options.maxBytes ?? DEFAULT_MAX_BYTES, hostOf(url))
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`Request to ${hostOf(url)} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
