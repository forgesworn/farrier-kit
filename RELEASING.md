# Releasing farrier-kit

Releases run through [semantic-release](https://semantic-release.gitbook.io/). The
version, git tag, GitHub release, and npm publish with provenance all come from
the Conventional Commit messages on `main`. You never hand-edit the version.
`package.json` stays at `0.0.0-development` and the real number is worked out at
publish time.

## One-time setup, the only manual step

The publish waits on an npm token. Until that token exists, the Release workflow
runs the full test and build gauntlet and then skips publishing. It goes green and
does nothing.

1. Create an npm automation token: npmjs.com, then Access Tokens, then Generate,
   then "Automation" (it bypasses 2FA in CI).
2. Add it to the repo: GitHub, then Settings, then Secrets and variables, then
   Actions, then New repository secret. Name it `NPM_TOKEN` and paste the token.

That is all. The first release is `1.0.0`, the audited core (`/bolt11`,
`/preimage`, `/lnurl`, `/http`).

## Cutting the release

Either one works:

- Push to `main`. Every push runs the Release workflow, and once `NPM_TOKEN` is
  set it publishes when there are releasable commits.
- Trigger it by hand. GitHub, then Actions, then Release, then "Run workflow"
  (`workflow_dispatch`). Handy for the very first publish without a new commit.

## How the version is chosen

| Commit type on `main` | Effect |
|---|---|
| `fix:` | patch (1.0.0 to 1.0.1) |
| `feat:` | minor (1.0.0 to 1.1.0), new modules land here |
| `feat!:` or a `BREAKING CHANGE:` footer | major (1.0.0 to 2.0.0) |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | no release |

New modules on the roadmap (`/nwc`, `/fiat`, and so on) are additive, so they ship
as minor bumps and never break a pinned consumer.

## What CI enforces before any publish

typecheck, no `node:` imports in library code, conformance vectors in sync, tests,
build, and the browser bundle resolving. A red gate blocks the release.

## Manual fallback, only if you ever bypass CI

```bash
npm login
npm version 1.0.0 --no-git-tag-version   # set a real version locally
npm publish                              # prepublishOnly re-runs the gauntlet
git checkout package.json                # restore 0.0.0-development
```

Prefer the automated path. It also creates the GitHub release and the provenance
attestation.
