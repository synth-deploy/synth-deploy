#!/usr/bin/env tsx
/**
 * Standalone CLI for running playbooks outside of vitest.
 *
 * Usage:
 *   npx tsx tests/playbooks/cli.ts                  # run all
 *   npx tsx tests/playbooks/cli.ts --type=maintain   # filter by type
 *   npx tsx tests/playbooks/cli.ts --tag=production   # filter by tag
 */
import path from "node:path";
import { runAllPlaybooks } from "./runner.js";
import type { PlaybookResult } from "./types.js";

const args = process.argv.slice(2);
const typeFilter = args.find((a) => a.startsWith("--type="))?.split("=")[1];
const tagFilter = args.find((a) => a.startsWith("--tag="))?.split("=")[1];

const playbookDir = path.resolve(import.meta.dirname, ".");

async function main() {
  console.log("\n  Synth Playbook Runner\n");
  console.log(`  Directory: ${playbookDir}`);
  if (typeFilter) console.log(`  Filter: type=${typeFilter}`);
  if (tagFilter) console.log(`  Filter: tag=${tagFilter}`);
  console.log("");

  const results = await runAllPlaybooks(playbookDir, {
    type: typeFilter,
    tags: tagFilter ? [tagFilter] : undefined,
  });

  printResults(results);

  const failed = results.filter((r) => !r.passed);
  process.exit(failed.length > 0 ? 1 : 0);
}

function printResults(results: PlaybookResult[]) {
  const maxName = Math.max(...results.map((r) => r.name.length), 10);

  for (const r of results) {
    const icon = r.passed ? "\x1b[32m PASS \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
    const name = r.name.padEnd(maxName);
    const duration = `${r.durationMs}ms`;
    console.log(`  ${icon} ${name}  [${r.type}]  ${duration}`);

    if (!r.passed) {
      if (r.error) {
        console.log(`         Error: ${r.error}`);
      }
      for (const a of r.assertions.filter((a) => !a.passed)) {
        console.log(`         - ${a.message}`);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} playbooks passed\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
