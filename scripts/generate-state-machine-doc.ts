#!/usr/bin/env node
/**
 * Regenerates docs/STATE-MACHINE.md from the transition table.
 *
 * The committed file is checked against this generator in CI, so the diagram in
 * the docs cannot drift from the machine the reducer actually asserts against.
 */
import { writeFileSync } from "node:fs";
import { renderStateMachineDoc } from "../src/orchestrator/doc.ts";

const target = new URL("../docs/STATE-MACHINE.md", import.meta.url);
writeFileSync(target, renderStateMachineDoc());
process.stdout.write(`wrote ${target.pathname}\n`);
