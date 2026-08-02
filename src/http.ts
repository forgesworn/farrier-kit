// fetch with a hard timeout and JSON handling. Some fetch implementations
// (node-fetch@2 among them) have NO default timeout — a hung upstream would
// otherwise hold its caller open forever.

export const DEFAULT_TIMEOUT_MS = 8000

export interface FetchJsonOptions {
  /** Injectable fetch (tests, node-fetch, undici). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  method?: string
  headers?: Record<string, string>
  /** Objects are JSON-serialised and content-type set, strings pass through. */
  body?: unknown
  /** Pass 'manual' to refuse redirects (SSRF: a public host must not bounce inward). */
  redirect?: RequestRedirect
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
    const init: RequestInit = { method: options.method ?? 'GET', headers, signal: controller.signal }
    if (options.redirect !== undefined) init.redirect = options.redirect
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')
      if (!hasContentType) headers['content-type'] = 'application/json'
    }
    const response = await fetchImpl(url, init)
    if (!response.ok) throw new HttpError(response.status, hostOf(url))
    return (await response.json()) as T
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`Request to ${hostOf(url)} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
