#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runSuite } from "./harness.ts";
import { gate, toBaseline, emptyBaseline, type Baseline } from "./baseline.ts";
import { renderJson, renderMarkdown, renderText } from "./report.ts";
import type { EvalSuite } from "./types.ts";

type Flags = Readonly<Record<string, string | true>>;

const USAGE = `escapement — eval harness

  escapement run      [--suite <path>] [--json <path>] [--md <path>]
  escapement gate     [--suite <path>] [--baseline <path>] [--md <path>] [--strict-trajectory]
  escapement baseline [--suite <path>] [--baseline <path>] [--tolerance <n>] [--force]

The baseline may only be re-recorded on a release/* branch (ADR-0012).
`;

async function main(argv: readonly string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const flags = parseFlags(rest);
  const suitePath = resolve(String(flags["suite"] ?? "evals/suite.ts"));
  const baselinePath = resolve(String(flags["baseline"] ?? "evals/baseline.json"));

  const suite = await loadSuite(suitePath);
  const result = await runSuite(suite);

  if (flags["json"]) writeOut(String(flags["json"]), JSON.stringify(result, null, 2));

  switch (command) {
    case "run": {
      process.stdout.write(renderText(result));
      if (flags["md"]) {
        const baseline = readBaseline(baselinePath) ?? emptyBaseline(suite.id);
        writeOut(String(flags["md"]), renderMarkdown(gate(result, baseline)));
      }
      return result.failed === 0 ? 0 : 1;
    }

    case "gate": {
      const baseline = readBaseline(baselinePath);
      if (!baseline) {
        // Bootstrap: a repository that has never cut a release has nothing to
        // regress from, so the bar is "every case passes". The baseline is
        // recorded at the first release (ADR-0012). Deleting it later is a diff
        // to evals/baseline.json, which the branch-policy CI job already
        // refuses outside a release branch — so this is not a hole to hide in.
        process.stdout.write(renderText(result));
        process.stderr.write(
          `\nNo baseline at ${baselinePath}. Gating on "every case passes" until one is recorded\n` +
            `on a release/* branch with 'npm run eval:baseline'.\n`,
        );
        return result.failed === 0 ? 0 : 1;
      }
      const outcome = gate(result, baseline, { strictTrajectory: flags["strict-trajectory"] === true });
      process.stdout.write(renderText(result));
      for (const finding of outcome.findings) {
        const stream = finding.severity === "error" ? process.stderr : process.stdout;
        stream.write(`  [${finding.severity}] ${finding.kind}: ${finding.message}\n`);
      }
      const markdown = renderMarkdown(outcome);
      if (flags["md"]) writeOut(String(flags["md"]), markdown);
      if (flags["json"]) writeOut(String(flags["json"]), renderJson(outcome));
      appendStepSummary(markdown);
      process.stdout.write(outcome.ok ? "\ngate: PASS\n" : "\ngate: FAIL\n");
      return outcome.ok ? 0 : 1;
    }

    case "baseline": {
      const allowed = flags["force"] === true || isReleaseBranch();
      if (!allowed) {
        process.stderr.write(
          "Refusing to re-record the baseline.\n\n" +
            "The baseline is a whole-suite judgement and belongs on a release/* branch,\n" +
            "so that no single feature can quietly ratchet the bar down for everyone else\n" +
            "(ADR-0012). If a score movement on your branch is correct, say so in the pull\n" +
            "request and leave the gate red.\n\n" +
            "Use --force only when you know why this rule does not apply.\n",
        );
        return 2;
      }
      const tolerance = Number(flags["tolerance"] ?? 0);
      const baseline = toBaseline(result, tolerance);
      writeOut(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      process.stdout.write(renderText(result));
      process.stdout.write(`\nrecorded ${Object.keys(baseline.cases).length} case(s) to ${baselinePath}\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function loadSuite(path: string): Promise<EvalSuite> {
  if (!existsSync(path)) throw new Error(`No eval suite at ${path}`);
  const module = (await import(pathToFileURL(path).href)) as { default?: EvalSuite; suite?: EvalSuite };
  const suite = module.default ?? module.suite;
  if (!suite) throw new Error(`${path} must default-export an EvalSuite`);
  return suite;
}

function readBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

function writeOut(path: string, content: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), content);
}

/**
 * Defence in depth for the ratchet rule. CI enforces it too, by refusing a diff
 * to evals/baseline.json on a branch that is not release/*; this catches the
 * local mistake before it becomes a pull request.
 */
function isReleaseBranch(): boolean {
  const fromEnv = process.env["GITHUB_HEAD_REF"] ?? process.env["ESCAPEMENT_BRANCH"];
  const branch = fromEnv ?? currentGitBranch();
  return branch !== null && branch.startsWith("release/");
}

function currentGitBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function appendStepSummary(markdown: string): void {
  const target = process.env["GITHUB_STEP_SUMMARY"];
  if (!target) return;
  try {
    writeFileSync(target, `${markdown}\n`, { flag: "a" });
  } catch {
    // A summary we could not write is not a reason to fail the gate.
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
