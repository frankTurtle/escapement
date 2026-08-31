# ADR-0016: Publishing is automated from tags, with guards and no long-lived secret

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

`0.1.1` was published by hand: `npm login`, `npm publish`, a 2FA prompt. That
works exactly once and then stops being a good idea, for three reasons.

**It is unrepeatable.** The published artifact came from one machine's working
tree. It happened to be clean and on the right commit, but nothing checked
that. A publish from a tree with an uncommitted experiment in it produces a
release that exists nowhere in git.

**It is unguarded.** Nothing verified that the version being published matched
the tag that was supposed to describe it, or that the commit had been through
the release process at all. npm versions are immutable, so each of those
mistakes is permanent.

**It requires a human at the keyboard with credentials.** Which means either the
credentials live on a laptop, or a long-lived automation token lives in a
secret store. Both are things to lose.

The counter-force: publishing is irreversible after 72 hours. Automation that
fires on a low-ceremony action — a push to a branch, a merge — would be
dangerous. Whatever triggers it has to be an action that already *means* "this
is a release".

## Decision

**Pushing a `vX.Y.Z` tag publishes that version to npm.**

A tag is the right trigger because, under our branching model
([ADR-0010](0010-gitflow-branching-model.md)), it already carries the meaning we
need: only `release/*` and `hotfix/*` merges reach `main`, and tagging is the
last step of that process. The tag is the reviewed artifact. The workflow adds
no judgement of its own — it re-verifies, checks that the tag and the manifest
agree, and publishes.

### Four guards, each a way a tag push can be wrong

| Guard | The mistake it catches |
| ----- | ---------------------- |
| Tag must be reachable from `main` | A tag pushed from a feature branch, which never went through the release process |
| Tag must equal `package.json` version | `v0.2.0` pointing at a manifest that says `0.1.1` — the registry and the tag would disagree forever |
| Version must not already exist on npm | A re-pushed tag, which npm would reject anyway but with a worse message |
| `verify` + `build` must pass | Publishing a tree whose tests do not pass |

`prepublishOnly` also runs verify and build, so the last one is belt and
braces. That is deliberate: as an explicit step it fails as a red check with a
readable log, rather than as an aborted publish.

### Prereleases do not become `latest`

A version containing a hyphen (`1.0.0-rc.1`) publishes under the `next`
dist-tag. Without this, tagging a release candidate would make
`npm install escapement` hand an RC to everyone. This is a one-line `case`
statement guarding a mistake that is invisible until users report it.

### Authentication: trusted publishing by default

The workflow requests `id-token: write` and publishes with `--provenance`. With
npm trusted publishing configured, npm accepts a short-lived OIDC token minted
per run, so **there is no long-lived npm credential anywhere** — not on a
laptop, not in GitHub secrets. Provenance also attests publicly which commit and
workflow produced the tarball.

A `secrets.NPM_TOKEN` fallback exists: if that secret is set, the workflow uses
token auth instead. It is there so publishing is not blocked on the one-time npm
web-UI setup, not because it is equally good.

### The environment is a place to put a human

The job declares `environment: npm`. With no protection rules that is a no-op.
It exists so that adding a required reviewer later is a settings change rather
than a workflow rewrite — a pause between "tag pushed" and "irreversible upload"
that costs nothing until you want it.

## Consequences

### What this buys us

- Every published artifact is built from a tagged commit by a clean checkout.
- The four mistakes above become red checks instead of permanent registry
  entries.
- No npm credential to leak, and public provenance linking the tarball to a
  commit.
- Releasing is `git push --tags`, which removes the temptation to skip steps.

### What this costs us

- **A tag push is now irreversible.** Pushing `v0.2.0` publishes, and tags are
  cheap to push by accident. The guards catch wrong tags, not premature correct
  ones. The `npm` environment is the mitigation for anyone who wants one.
- **Trusted publishing needs a one-time setup** in the npm web UI, linking the
  package to this repository and workflow file. Until that is done, publishing
  requires the `NPM_TOKEN` fallback.
- **Renaming `publish.yml` breaks trusted publishing**, because npm's config
  pins the workflow filename. That is a surprising failure and it is written
  down here so the next person finds it.
- CI now has the ability to publish, which is a real increase in what a
  compromised workflow could do.

### What we are explicitly giving up

Publishing anything that is not a tagged commit on `main` — no publishing from a
branch, no nightly builds, no manual `workflow_dispatch`. Each would be a second
path to the registry with weaker guarantees, and one path is the point. A
prerelease still goes out the same way: bump to `0.2.0-rc.1` on a release
branch, tag it, and it publishes under `next`.

We also do not tag automatically. Cutting the version stays a deliberate human
act on a release branch; automation begins the moment the tag exists.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Publish on merge to `main` | Every merge would publish, including a hotfix back-merge. The version bump, not the merge, is the release decision. |
| Publish on GitHub Release published | Nearly equivalent and slightly safer, since creating a release is more deliberate than pushing a tag. Rejected because it puts the trigger in a web UI rather than in git, and `git push --tags` is already how the documented release checklist ends. |
| `workflow_dispatch` with a version input | A human types the version twice and can typo it. The tag already says it. |
| Keep publishing by hand | Unrepeatable, unguarded, and needs credentials on a laptop. |
| Long-lived `NPM_TOKEN` as the primary path | A permanent credential with publish rights, which is precisely what trusted publishing exists to remove. Kept only as a fallback. |
