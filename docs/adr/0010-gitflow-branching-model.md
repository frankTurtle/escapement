# ADR-0010: GitFlow branching model

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Escapement makes a promise about *stability of behaviour*, not just stability of
API. When someone pins `escapement@0.3.1`, they are pinning a set of eval scores
their own CI gate is calibrated against. An unannounced behaviour change is as
breaking as a removed export.

That pushes us toward a release model with:

- a branch that is always exactly what is published, so `git checkout v0.3.1`
  reproduces a released artifact byte for byte;
- a place where features integrate and can be *collectively* re-graded by the
  eval suite before anyone depends on them;
- a stabilisation window where a release candidate accepts fixes and doc work
  but no new features, so the eval baseline can settle;
- a path to ship an urgent fix against what is published without dragging along
  whatever is half-finished on the integration branch.

## Decision

We use GitFlow, as originally described by Vincent Driessen.

### Long-lived branches

| Branch | Meaning | Accepts commits from |
| ------ | ------- | -------------------- |
| `main` | Exactly what is released. Every commit is tagged `vX.Y.Z`. | `release/*`, `hotfix/*` merges only |
| `develop` | Integration branch. The next release, as it stands today. | `feature/*`, `release/*`, `hotfix/*` back-merges |

`develop` is the repository's **default branch**, so contributor pull requests
target it by default and reaching `main` requires deliberate action.

### Supporting branches

| Prefix | From | Merges to | Purpose |
| ------ | ---- | --------- | ------- |
| `feature/*` | `develop` | `develop` | One coherent capability |
| `release/*` | `develop` | `main` **and** `develop` | Version bump, changelog, baseline refresh, docs. No new features. |
| `hotfix/*` | `main` | `main` **and** `develop` | Urgent fix against what is published |

### Rules

1. **All merges into `develop` and `main` use `--no-ff`.** The merge commit is
   the unit of "one feature landed", which makes `git log --first-parent develop`
   a readable changelog and makes a single feature revertable in one commit.
2. **Every merge to `main` is immediately tagged** `vX.Y.Z`, and the release or
   hotfix branch is then back-merged to `develop` so the two never diverge.
3. **Commit messages follow Conventional Commits.** The type prefix drives the
   changelog and the semver bump on the release branch.
4. **Eval gates run on every pull request** ([ADR-0012](0012-eval-regression-gates.md)).
   The baseline may only be re-recorded on a `release/*` branch, so no single
   feature can quietly ratchet the bar down for everyone else.
5. Feature branches are deleted after merge. The `--no-ff` merge commit is the
   surviving record.

## Consequences

### What this buys us

- `main` is a trustworthy, taggable, always-releasable artifact.
- The release branch gives us a real stabilisation window, which is exactly
  where an eval baseline refresh belongs — it is a whole-suite judgement, not a
  per-feature one.
- Hotfixes do not require `develop` to be releasable.
- `--first-parent` history reads as a feature list.

### What this costs us

- It is heavier than trunk-based development: more branches, two merges per
  release, and a real risk of long-lived feature branches drifting from
  `develop`. Mitigation: features stay small, and rebasing onto `develop` before
  opening a PR is expected.
- Two integration points means merge conflicts can appear twice, most often in
  `CHANGELOG.md` and the eval baseline.

### What we are explicitly giving up

Continuous deployment from trunk. We are a library with a behavioural contract,
not a service, so the release cadence is deliberately punctuated rather than
continuous. A project that shipped on every merge to trunk would make a
different call here, correctly.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Trunk-based with feature flags | Excellent for services, poor for a library: there is no "deploy" to hide behind a flag, and consumers would see behaviour drift between patch versions. |
| GitHub Flow (branch off `main`, merge, release from `main`) | No stabilisation window, so the eval baseline can only ever be refreshed on a commit that is already released. |
| Release trains on a cadence | Attractive later, but it presumes a contributor volume we do not have; GitFlow degrades gracefully to one release when there is one feature. |
