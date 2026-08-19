/**
 * The farrier-kit bench.
 *
 * Every verdict on this page comes out of `../src/index.js` — the same code
 * the package publishes, bundled for the browser and run in yours. There is no
 * mock layer and no server: paste something in and the shipped decoder either
 * accepts it or refuses it in front of you.
 *
 * Nothing here touches the network. The LNURL resolution surface is
 * deliberately absent: it needs a live host and a CORS policy neither we nor
 * the reader control, and a demo that fails for an unrelated reason teaches
 * the wrong lesson.
 */
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import {
  assertResolvableUrl,
  computePaymentHash,
  explainPreimage,
  generatePreimage,
  isPrivateIpLiteral,
  lnurlPayUrl,
  msatsToSatsFloor,
  parseLightningAddress,
  tryDecodeBolt11,
  verifyInvoiceCommitment,
  verifyPreimage,
  type DecodedBolt11,
} from '../src/index.js'

import bolt11Vectors from '../vectors/bolt11.json'
import descriptionHashVectors from '../vectors/description-hash.json'
import lightningAddressVectors from '../vectors/lightning-address.json'
import preimageVectors from '../vectors/preimage.json'
import ssrfVectors from '../vectors/ssrf.json'

// ── DOM helpers ─────────────────────────────────────────────────────────────

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`missing element #${id}`)
  return found as T
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A pass/fail/idle chip plus an optional sentence explaining it. */
function verdict(out: HTMLElement, state: 'pass' | 'fail' | 'idle', label: string, why?: string): void {
  const chip = make('p', `verdict verdict-${state}`, label)
  out.append(chip)
  if (why) {
    const p = make('p', 'verdict-why')
    p.textContent = why
    out.append(p)
  }
}

function fieldList(out: HTMLElement, rows: Array<[string, string | null, 'hot' | null]>): void {
  const dl = make('dl', 'fields')
  for (const [key, value, tone] of rows) {
    const row = make('div')
    row.append(make('dt', undefined, key))
    const dd = make('dd', value === null ? 'null' : (tone ?? undefined))
    dd.textContent = value === null ? 'null' : value
    row.append(dd)
    dl.append(row)
  }
  out.append(dl)
}

function placeholder(out: HTMLElement, text: string): void {
  out.append(make('p', 'bench-empty', text))
}

// ── tool 1: decode a BOLT-11 invoice ────────────────────────────────────────

// A BOLT-11 specification test vector. Unsigned, long expired, and worth
// nothing: this page will not hand anyone a payable invoice.
const SAMPLE_INVOICE =
  'lnbc2500u1pj48ugqpp55xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xssdqdxysxxmmxvejk2xqzpuqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq02rq0p'

function formatMsats(msats: bigint | null): string {
  if (msats === null) return 'null'
  const sats = msatsToSatsFloor(msats)
  return `${msats.toString()} msat  (${sats.toLocaleString('en-GB')} sat)`
}

function formatWhen(seconds: number): string {
  return `${seconds}  (${new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')})`
}

function describeInvoice(out: HTMLElement, decoded: DecodedBolt11): void {
  const expiresAt = decoded.timestamp + decoded.expirySeconds
  const expired = expiresAt * 1000 < Date.now()
  fieldList(out, [
    ['network', decoded.network, 'hot'],
    ['amount', formatMsats(decoded.amountMsats), decoded.amountMsats === null ? null : 'hot'],
    ['whole sats', decoded.amountSats === null ? null : String(decoded.amountSats), null],
    ['payment_hash', decoded.paymentHashHex, null],
    ['payment_secret', decoded.paymentSecretHex, null],
    ['description', decoded.description, null],
    ['description_hash', decoded.descriptionHashHex, null],
    ['timestamp', formatWhen(decoded.timestamp), null],
    ['expiry', `${decoded.expirySeconds}s → ${formatWhen(expiresAt)}`, null],
    ['expired', expired ? 'yes' : 'no', null],
    ['min_final_cltv', decoded.minFinalCltvExpiry === null ? null : String(decoded.minFinalCltvExpiry), null],
  ])
}

function runDecode(): void {
  const out = element('decode-out')
  const raw = element<HTMLTextAreaElement>('decode-input').value.trim()
  clear(out)
  if (!raw) {
    placeholder(out, 'Paste a BOLT-11 invoice, or load the sample. Nothing is sent anywhere; the decoder runs here.')
    return
  }
  const decoded = tryDecodeBolt11(raw)
  if (decoded === null) {
    verdict(
      out,
      'fail',
      'refused',
      'tryDecodeBolt11 returned null. It refuses rather than guessing: a bad checksum, an ambiguous amount, a missing payment_hash or a numeric field that would overflow all end here, because a half-read invoice is more dangerous than an unread one.',
    )
    return
  }
  verdict(out, 'pass', 'decoded', 'These are the fields the invoice commits to. Nothing below was inferred.')
  describeInvoice(out, decoded)
}

// ── tool 2: preimage against payment hash ───────────────────────────────────

function runPreimage(): void {
  const out = element('preimage-out')
  const preimage = element<HTMLInputElement>('preimage-input').value.trim()
  const hash = element<HTMLInputElement>('hash-input').value.trim()
  clear(out)
  if (!preimage && !hash) {
    placeholder(
      out,
      'A payment_hash is SHA-256 of the preimage. Holding a preimage that hashes to the invoice’s payment_hash is the proof that the invoice was paid. Generate a pair, then change one character of either.',
    )
    return
  }
  const result = explainPreimage({ preimage, paymentHash: hash })
  if (result.ok) {
    verdict(out, 'pass', 'settled', 'This preimage hashes to that payment_hash, so it proves the invoice was paid. The comparison is constant-time.')
  } else {
    verdict(out, 'fail', 'not proof', result.reason ?? 'refused')
  }
  const rows: Array<[string, string | null, 'hot' | null]> = []
  if (/^[0-9a-f]{64}$/i.test(preimage)) {
    rows.push(['sha256(preimage)', computePaymentHash(preimage), 'hot'])
  }
  rows.push(['committed hash', hash || null, null])
  rows.push(['verifyPreimage', String(verifyPreimage(preimage, hash)), null])
  fieldList(out, rows)
}

function generatePair(): void {
  const preimage = generatePreimage()
  element<HTMLInputElement>('preimage-input').value = preimage
  element<HTMLInputElement>('hash-input').value = computePaymentHash(preimage)
  runPreimage()
}

// ── tool 3: the pre-payment commitment gate ─────────────────────────────────

function runCommitment(): void {
  const out = element('commit-out')
  const invoice = element<HTMLTextAreaElement>('commit-invoice').value.trim()
  const hash = element<HTMLInputElement>('commit-hash').value.trim()
  const msatsRaw = element<HTMLInputElement>('commit-msats').value.trim()
  clear(out)
  if (!invoice && !hash) {
    placeholder(
      out,
      'The check to run before money moves. A payment_hash on its own is not enough: the payee picks the preimage, so they can mint a second invoice with the same hash and a different amount. Give it the amount you agreed as well.',
    )
    return
  }
  let expectedMsats: bigint | undefined
  if (msatsRaw) {
    try {
      expectedMsats = BigInt(msatsRaw)
    } catch {
      verdict(out, 'fail', 'bad input', 'Expected amount must be a whole number of millisatoshis.')
      return
    }
  }
  const result = verifyInvoiceCommitment({ bolt11: invoice, paymentHash: hash, expectedMsats })
  if (result.ok && result.verified) {
    verdict(out, 'pass', 'safe to pay', 'The invoice commits to that payment_hash, that amount and that network.')
  } else if (result.ok) {
    verdict(out, 'idle', 'deferred', result.reason ?? 'Not verified here; the caller asked for a deferral.')
  } else {
    verdict(out, 'fail', 'do not pay', result.reason ?? 'refused')
  }
  fieldList(out, [
    ['ok', String(result.ok), null],
    ['verified', result.verified === undefined ? null : String(result.verified), null],
    ['reason', result.reason ?? null, null],
    ['invoice amount', result.amountMsats === undefined ? null : formatMsats(result.amountMsats), 'hot'],
    ['network', result.network ?? null, null],
    ['expected msats', expectedMsats === undefined ? null : expectedMsats.toString(), null],
  ])
}

// ── tool 4: the URL gate ────────────────────────────────────────────────────

function runUrl(): void {
  const out = element('url-out')
  const raw = element<HTMLInputElement>('url-input').value.trim()
  clear(out)
  if (!raw) {
    placeholder(
      out,
      'Before farrier-kit will fetch an LNURL endpoint it classifies the URL: HTTPS only, no embedded credentials, no localhost, no private or reserved IP literal. Try http://, or https://10.0.0.1/x, or a Lightning Address.',
    )
    return
  }
  if (raw.includes('@') && !raw.includes('://')) {
    try {
      const parsed = parseLightningAddress(raw)
      const url = lnurlPayUrl(parsed)
      verdict(out, 'pass', 'address accepted', 'A Lightning Address resolves to this well-known URL, which then goes through the same gate.')
      fieldList(out, [
        ['name', parsed.name, null],
        ['domain', parsed.domain, null],
        ['lnurlp url', url, 'hot'],
        ['gate', (() => {
          try {
            assertResolvableUrl(url)
            return 'passes'
          } catch (error) {
            return `refused: ${(error as Error).message}`
          }
        })(), null],
      ])
    } catch (error) {
      verdict(out, 'fail', 'refused', (error as Error).message)
    }
    return
  }
  try {
    const url = assertResolvableUrl(raw)
    verdict(out, 'pass', 'resolvable', 'HTTPS, a public host, and no credentials in the URL.')
    fieldList(out, [
      ['scheme', url.protocol.replace(':', ''), null],
      ['host', url.hostname, 'hot'],
      ['ip literal', isPrivateIpLiteral(url.hostname) ? 'private' : 'not a private literal', null],
      ['path', url.pathname + url.search, null],
    ])
  } catch (error) {
    verdict(out, 'fail', 'refused', (error as Error).message)
  }
  const note = make('p', 'hint')
  note.textContent =
    'This gate classifies IP literals. A hostname that resolves inward needs the DNS-pinned fetch in farrier-kit/node; the browser cannot resolve DNS, so no in-page check can close that gap.'
  out.append(note)
}

// ── the conformance vectors ─────────────────────────────────────────────────

interface VectorOutcome {
  file: string
  what: string
  passed: number
  total: number
  failures: string[]
}

function sha256Utf8(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)))
}

function check(outcome: VectorOutcome, name: string, ok: boolean): void {
  outcome.total += 1
  if (ok) outcome.passed += 1
  else outcome.failures.push(name)
}

function runVectors(): VectorOutcome[] {
  const results: VectorOutcome[] = []

  const bolt11: VectorOutcome = { file: 'bolt11.json', what: 'Invoice decoding, and the inputs a decoder must refuse', passed: 0, total: 0, failures: [] }
  for (const v of bolt11Vectors.valid) {
    const decoded = tryDecodeBolt11(v.invoice)
    let ok = decoded !== null
    if (decoded) {
      const want = v.decoded as Record<string, unknown>
      for (const [key, expected] of Object.entries(want)) {
        const actual = (decoded as unknown as Record<string, unknown>)[key]
        const same = typeof actual === 'bigint' ? actual.toString() === expected : actual === expected
        if (!same) ok = false
      }
    }
    check(bolt11, v.name, ok)
  }
  for (const v of bolt11Vectors.errors) {
    check(bolt11, v.name, tryDecodeBolt11(v.invoice) === null)
  }
  results.push(bolt11)

  const preimage: VectorOutcome = { file: 'preimage.json', what: 'payment_hash = SHA-256(preimage), and the pairs that must not match', passed: 0, total: 0, failures: [] }
  for (const v of preimageVectors.hash) {
    check(preimage, `hash ${v.preimage.slice(0, 8)}…`, computePaymentHash(v.preimage) === v.paymentHash)
  }
  for (const v of preimageVectors.verify) {
    check(preimage, `verify ${v.preimage.slice(0, 8)}… → ${v.valid}`, verifyPreimage(v.preimage, v.paymentHash) === v.valid)
  }
  results.push(preimage)

  const ssrf: VectorOutcome = { file: 'ssrf.json', what: 'Which IP literals are private or reserved, and which are not', passed: 0, total: 0, failures: [] }
  for (const host of ssrfVectors.private) {
    check(ssrf, `${host} is private`, isPrivateIpLiteral(host) === true)
  }
  for (const host of ssrfVectors.public) {
    check(ssrf, `${host} is public`, isPrivateIpLiteral(host) === false)
  }
  results.push(ssrf)

  const address: VectorOutcome = { file: 'lightning-address.json', what: 'LUD-16 parsing, canonicalisation and the well-known URL', passed: 0, total: 0, failures: [] }
  for (const v of lightningAddressVectors.valid) {
    let ok = false
    try {
      const parsed = parseLightningAddress(v.input)
      ok = parsed.name === v.name && parsed.domain === v.domain
    } catch {
      ok = false
    }
    check(address, v.input, ok)
  }
  for (const input of lightningAddressVectors.invalid) {
    let refused = false
    try {
      parseLightningAddress(input)
    } catch {
      refused = true
    }
    check(address, `refuses ${JSON.stringify(input)}`, refused)
  }
  for (const v of lightningAddressVectors.lnurlpUrl) {
    check(address, `${v.name}@${v.domain}`, lnurlPayUrl({ name: v.name, domain: v.domain }) === v.url)
  }
  results.push(address)

  const dhash: VectorOutcome = { file: 'description-hash.json', what: 'The h tag an LNURL or zap invoice must commit to', passed: 0, total: 0, failures: [] }
  for (const v of descriptionHashVectors.vectors) {
    check(dhash, v.kind, sha256Utf8(v.input) === v.descriptionHashHex)
  }
  results.push(dhash)

  return results
}

function renderVectors(): void {
  const rows = element('vec-rows')
  const total = element('vec-total')
  clear(rows)

  const started = performance.now()
  const results = runVectors()
  const elapsed = performance.now() - started

  let passed = 0
  let count = 0
  for (const r of results) {
    passed += r.passed
    count += r.total

    const row = make('div', 'vec-row')
    row.append(make('span', 'vec-file', r.file))
    row.append(make('span', 'vec-what', r.what))
    const tally = make('span', `vec-count ${r.passed === r.total ? 'pass' : 'fail'}`)
    tally.textContent = `${r.passed}/${r.total}`
    row.append(tally)
    if (r.failures.length > 0) {
      row.append(make('pre', 'vec-fails', r.failures.join('\n')))
    }
    rows.append(row)
  }

  total.className = `vec-total ${passed === count ? 'pass' : 'fail'}`
  total.textContent = `${passed}/${count} passed in ${elapsed.toFixed(1)} ms`
}

// ── wiring ──────────────────────────────────────────────────────────────────

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
  button.addEventListener('click', () => {
    const tool = button.dataset.tool
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      other.setAttribute('aria-selected', String(other === button))
    }
    for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tool
    }
  })
}

element('decode-input').addEventListener('input', runDecode)
element('decode-sample').addEventListener('click', () => {
  element<HTMLTextAreaElement>('decode-input').value = SAMPLE_INVOICE
  runDecode()
})
element('decode-clear').addEventListener('click', () => {
  element<HTMLTextAreaElement>('decode-input').value = ''
  runDecode()
})

element('preimage-input').addEventListener('input', runPreimage)
element('hash-input').addEventListener('input', runPreimage)
element('preimage-generate').addEventListener('click', generatePair)

element('commit-invoice').addEventListener('input', runCommitment)
element('commit-hash').addEventListener('input', runCommitment)
element('commit-msats').addEventListener('input', runCommitment)
element('commit-sample').addEventListener('click', () => {
  element<HTMLTextAreaElement>('commit-invoice').value = SAMPLE_INVOICE
  element<HTMLInputElement>('commit-hash').value =
    'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
  element<HTMLInputElement>('commit-msats').value = '250000000'
  runCommitment()
})

element('url-input').addEventListener('input', runUrl)

element('vec-run').addEventListener('click', renderVectors)

runDecode()
runPreimage()
runCommitment()
runUrl()
