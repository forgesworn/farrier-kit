# Releasing farrier-kit

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/):
version, git tag, GitHub release, and npm publish (with provenance) are all
derived from the Conventional Commit messages on `main`. You never hand-edit the
version — `package.json` stays `0.0.0-development` and the real number is
computed at publish time.

## One-time setup (the only manual step)

The publish is gated on an npm token. Until it exists, the Release workflow runs
the full test/build gauntlet and then **skips publishing** (green, no-op).

1. Create an npm **automation** token: npmjs.com → Access Tokens → Generate →
   "Automation" (bypasses 2FA in CI).
2. Add it to the repo: GitHub → Settings → Secrets and variables → Actions →
   New repository secret → name `NPM_TOKEN`, value the token.

That's it. The first release is **1.0.0** (the audited core: `/bolt11`,
`/preimage`, `/lnurl`, `/http`).

## Cutting the release

Either:

- **Push to `main`** — every push runs the Release workflow; once `NPM_TOKEN` is
  set it publishes if there are releasable commits, or
- **Trigger manually** — GitHub → Actions → Release → "Run workflow"
  (`workflow_dispatch`), useful for the very first publish without a new commit.

## How the version is chosen

| Commit type on `main` | Effect |
|---|---|
| `fix:` | patch (1.0.0 → 1.0.1) |
| `feat:` | minor (1.0.0 → 1.1.0) — new modules land here |
| `feat!:` / `BREAKING CHANGE:` footer | major (1.0.0 → 2.0.0) |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | no release |

New modules on the roadmap (`/nwc`, `/fiat`, …) are additive, so they ship as
minor bumps and never break a pinned consumer.

## What CI enforces before any publish

typecheck · no `node:` imports in library code · conformance vectors in sync ·
tests · build · browser-bundle resolves. A red gate blocks the release.

## Manual fallback (only if you ever bypass CI)

```bash
npm login
npm version 1.0.0 --no-git-tag-version   # set a real version locally
npm publish                              # prepublishOnly re-runs the gauntlet
git checkout package.json                # restore 0.0.0-development
```

Prefer the automated path — it also creates the GitHub release and provenance
attestation.
