# GitFlow cheatsheet

The reasoning is in [ADR-0010](adr/0010-gitflow-branching-model.md). This is the
command-level version.

```
main     ●────────────────────────────●──────────────●      tagged releases
          \                          /              /
develop    ●──●──●──●──●──●──●──●───●──────●───────●        integration
            \    /    \    /        \     /       /
feature/*    ●──●      ●──●          \   /       /
                                release/0.1.0   /
hotfix/*                                 ●─────●
```

## Add a feature

```bash
git checkout develop && git pull --ff-only
git checkout -b feature/context-compaction
# ... commits ...
npm run verify
git push -u origin feature/context-compaction
gh pr create --base develop --fill
```

Merged with `--no-ff` so the feature survives as one revertable commit:

```bash
git checkout develop
git merge --no-ff feature/context-compaction
git branch -d feature/context-compaction
git push origin develop --delete-remote-if-merged 2>/dev/null || git push origin develop
```

## Cut a release

```bash
git checkout -b release/0.2.0 develop
npm version 0.2.0 --no-git-tag-version
# update CHANGELOG.md
npm run eval:baseline        # only legal on a release/* branch
npm run verify
git commit -am "chore(release): 0.2.0"

git checkout main && git merge --no-ff release/0.2.0
git tag -a v0.2.0 -m "Escapement 0.2.0"

git checkout develop && git merge --no-ff release/0.2.0   # never skip this
git branch -d release/0.2.0
git push origin main develop --tags
```

The back-merge into `develop` is the step people forget. Skip it and the version
bump, the changelog, and the refreshed baseline exist only on `main`, so the next
release branch starts from stale state and re-conflicts every time.

## Ship a hotfix

```bash
git checkout -b hotfix/0.2.1 main
# ... fix, plus an eval case that fails without it ...
npm version 0.2.1 --no-git-tag-version
npm run verify
git commit -am "fix(orchestrator): 0.2.1 — bound retry backoff"

git checkout main && git merge --no-ff hotfix/0.2.1 && git tag -a v0.2.1 -m "Escapement 0.2.1"
git checkout develop && git merge --no-ff hotfix/0.2.1
git push origin main develop --tags
```

A hotfix without a regression eval case is not finished. The eval suite is how
we guarantee the bug does not come back.

## Rules the tooling enforces

| Rule | Enforced by |
| ---- | ----------- |
| PRs target `develop` | Repository default branch |
| No direct pushes to `main` | Branch protection |
| `evals/baseline.json` changes only on `release/*` | `branch-policy` job in CI |
| `dependencies` stays empty | `deps-guard` job in CI |
| Every `main` commit is tagged | Release checklist, above |

## Reading the history

```bash
git log --first-parent develop --oneline      # one line per feature landed
git log --first-parent main --oneline         # one line per release
git tag --sort=-v:refname                     # every released version
```
