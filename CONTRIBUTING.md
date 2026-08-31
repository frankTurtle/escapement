# Contributing to Escapement

## The short version

```bash
git checkout develop && git pull
git checkout -b feature/my-thing
# ...work...
npm run verify        # typecheck + tests + eval gate
git push -u origin feature/my-thing
gh pr create --base develop
```

Pull requests target **`develop`**, never `main`. See
[ADR-0010](docs/adr/0010-gitflow-branching-model.md) for why.

## Branching

We use GitFlow. The full model is in
[ADR-0010](docs/adr/0010-gitflow-branching-model.md); the operational cheatsheet
is [docs/GITFLOW.md](docs/GITFLOW.md).

| You are... | Branch from | Prefix |
| ---------- | ----------- | ------ |
| adding a capability | `develop` | `feature/` |
| preparing a version | `develop` | `release/` |
| fixing something released | `main` | `hotfix/` |

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). The type drives
the changelog and the semver bump.

```
feat(orchestrator): add HALTED_BUDGET terminal state
fix(context): count tool schemas against the reserve, not the discretionary pool
docs(adr): supersede ADR-0008 with the exact-count tokenizer port
```

Scopes: `orchestrator`, `context`, `evals`, `core`, `tools`, `providers`,
`ci`, `adr`, `docs`.

## Architecture decisions

If your change would alter a public API, touch more than one module, or change
a guarantee we advertise (determinism, budget enforcement, gate semantics), it
needs an ADR **in the same pull request**. Copy
[`docs/adr/0000-template.md`](docs/adr/0000-template.md), take the next free
number, and add a row to [`docs/DECISIONS.md`](docs/DECISIONS.md).

Fill in *Alternatives considered*. A decision with no rejected alternative is
not a decision.

## The bars your PR has to clear

`npm run verify` runs all three locally. CI runs the same thing.

1. **`npm run typecheck`** — strict, and it includes tests and evals.
2. **`npm test`** — `node:test`. New behaviour needs a test; new *states* or
   *transitions* need a test that asserts the illegal ones still throw.
3. **`npm run eval:gate`** — the trajectory eval suite, compared against the
   committed baseline. See [docs/EVALS.md](docs/EVALS.md).

### About the eval baseline

`evals/baseline.json` is the recorded score of every eval case. The gate fails
if any case regresses beyond tolerance.

**You may not re-record the baseline on a feature branch.** If your change
legitimately moves scores, say so in the PR description and leave the gate red;
the baseline is refreshed once, deliberately, on the `release/*` branch, where
the whole suite is judged together. CI enforces this — `eval:baseline` writes
are rejected on any branch that is not `release/*`.

## Runtime dependencies

The `dependencies` block in `package.json` is empty and CI enforces it. If you
need something from the ecosystem, define a **port** (a narrow interface) and
ship a default in-repo implementation; the real adapter belongs in `examples/`
or in a separate package. [ADR-0003](docs/adr/0003-typescript-esm-zero-runtime-dependencies.md)
has the reasoning and the current list of ports.

## Style notes that the compiler cannot enforce

- No `enum`, no `namespace`, no parameter properties — `erasableSyntaxOnly` is
  on so Node can run the source directly. Use `const` objects plus union types.
- State transitions live in the transition table, not in `if` statements
  scattered through the runtime.
- Reducers are pure. If your code does I/O, it belongs in an effect handler.
