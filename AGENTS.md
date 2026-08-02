# Agent instructions

This repo uses `CLAUDE.md` as the canonical agent-facing instruction file. Any
coding agent (Claude Code, Codex, Cursor, Copilot, Gemini) should read it before
making changes:

- [`CLAUDE.md`](CLAUDE.md) -- architecture, constraints, testing, the release
  process, conventions, and non-goals.

Key points that apply to any agent:

- **@noble-only core, no `node:` imports in `src/`.** The library runs in the
  browser. CI greps for `node:` imports and bundles the output for a browser
  target. Do not add heavy dependencies (`nostr-tools`, `ln-service`) to the core.
- **Safe by default is load-bearing.** Do not weaken the SSRF guard in `lnurl.ts`
  or the amount/network gate in `verifyInvoiceCommitment` without an adversarial
  review and a regression test. The library was security-audited.
- **Conformance vectors are a contract.** `vectors/*.json` are what Kotlin/Swift
  ports validate against. Regenerate with `node scripts/gen-vectors.mjs`, never by
  hand; CI fails on drift.
- **British English, and no em dashes** anywhere (docs, comments, commits). Plain
  human voice.
- **Commit style**: `type: description`, lowercase imperative. No `Co-Authored-By`.
- **Releases go through forgesworn/anvil** (OIDC, no token). Bump `package.json`,
  add a `CHANGELOG.md` entry, `gh release create vX.Y.Z`. See `RELEASING.md`. Never
  run `npm publish` from the wrong directory, and never create a GitHub Release for
  a version already on npm.

Local gate before pushing:

```sh
npm run typecheck && npm run check:no-node-imports && npm test && npm run build && npm run check:browser-bundle
node scripts/gen-vectors.mjs && git diff --exit-code vectors/*.json
```
