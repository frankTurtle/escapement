## What changed

<!-- One paragraph. What does the system do now that it did not before? -->

## Why

<!-- Link the ADR if there is one. If this changes a public API, a guarantee, or
     more than one module, there must be one — see CONTRIBUTING.md. -->

- ADR: <!-- docs/adr/00XX-....md, or "n/a — local change" -->

## Checklist

- [ ] Targets `develop` (or is a `release/*` / `hotfix/*` PR into `main`)
- [ ] Conventional Commit messages
- [ ] `npm run verify` passes locally
- [ ] New behaviour has tests; new states/transitions assert the illegal ones throw
- [ ] `evals/baseline.json` is **unchanged** (unless this is a `release/*` PR)
- [ ] `dependencies` in `package.json` is still empty

## Eval movement

<!-- Paste the gate summary if any case moved, and say why the movement is
     correct. Do not re-record the baseline to make the gate green. -->
