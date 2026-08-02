# Releasing farrier-kit

Releases run through [forgesworn/anvil](https://github.com/forgesworn/anvil), our
hardened npm publish action. Once it is set up, a release is OIDC trusted
publishing with no npm token in the repo, a SLSA provenance attestation, a secret
scan over the exact files being published, an exports check, the frozen-vector
gate, and a two-runner reproducible-build attestation.

You control the version. Bump `package.json`, add the CHANGELOG entry, and cut the
release. anvil does the rest.

## First publish, a one-time bootstrap

npm's trusted-publisher flow needs the package to already exist on the registry.
`farrier-kit` has never been published, so the very first publish is a manual one
from your machine. This is the only time you use a token.

```bash
cd farrier-kit
npm login                                  # browser and 2FA
npm whoami                                 # confirm
npm publish --no-provenance --access public
```

`--no-provenance` is needed because provenance can only be generated inside CI,
where the OIDC token exists. `prepublishOnly` runs the full gauntlet (typecheck,
the no-`node:`-imports gate, all tests, the build, and the browser-bundle check)
before anything leaves your machine.

That publishes `farrier-kit@1.0.0` and claims the name. Tag it so the repo has an
anchor, but do not create a GitHub Release for `v1.0.0`, since that would trigger
anvil to try to publish `1.0.0` again:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Set up trusted publishing (one-off, on npmjs.com)

After the first publish, wire OIDC so no token is ever needed again.

1. npmjs.com, your package, Settings, Trusted Publisher.
2. Add a GitHub Actions publisher:
   - Repository: `forgesworn/farrier-kit`
   - Workflow filename: `release.yml` (this repo's caller, not anvil's reusable
     workflow). npm matches the OIDC `workflow_ref` claim, which is the caller.
   - Environment: `npm-publish`
3. Then turn on "require 2FA and disallow tokens" for the package, so the only way
   to publish is through this workflow. The bootstrap token can be revoked.

## Every release after the first

1. Bump `version` in `package.json` (patch, minor, or major).
2. Add a `## [x.y.z]` section to `CHANGELOG.md`. anvil puts it in the release body.
3. Commit and push to `main`.
4. Cut the release from the command line:

   ```bash
   gh release create v1.1.0 --title v1.1.0 --notes-from-tag
   ```

   The `release: published` event fires `release.yml`, which runs anvil: gates,
   the frozen-vector check, the two-runner reproducible build, then an
   OIDC-authenticated publish and a release-body update with the tarball hash.

You can also publish a specific tag by hand from Actions, Release, Run workflow.

## What anvil enforces before it publishes

Tests, the frozen-vector gate (`npm run test:vectors`), a runtime-only
`npm audit`, an exports-map check that every subpath in `package.json` exists on
disk, a secret scan over the pack set, an action-pin audit, and a reproducible
build across two runners. A failure blocks the publish.

## Hardening status

Both gates in `release.yml` run strict as of 1.0.1:

- `strict-action-pins: true`. The `uses:` refs in `ci.yml` are pinned to commit
  SHAs, so any unpinned action fails the release.
- `reproducibility-mode: strict`. The 1.0.1 release confirmed the tsup build is
  byte-identical across two independent runners, so a mismatch now blocks the
  publish.
