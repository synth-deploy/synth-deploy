#!/usr/bin/env node
/**
 * synth CLI — local execution mode
 *
 * Usage:
 *   synth local run <playbook.yaml>
 *   synth local run <playbook.yaml> --param key=value --param key2=value2
 *   synth local run <playbook.yaml> --llm-key sk-...
 *   synth local run <playbook.yaml> --verbose
 *
 * Playbook format (YAML):
 *
 *   name: "My pipeline"
 *   environment:
 *     name: local
 *     variables:
 *       DB_HOST: localhost
 *   steps:
 *     - type: query
 *       intent: "Check disk usage on /var/log"
 *     - type: execute
 *       intent: "Archive log files older than 30 days"
 *
 * Valid step types: deploy, maintain, query, investigate, execute, trigger
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LocalExecutor } from "./local-executor.js";
import type { LocalOperationSpec } from "./local-executor.js";

// ---------------------------------------------------------------------------
// Playbook schema
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  type: z.enum(["deploy", "query", "investigate", "maintain", "execute", "trigger"]),
  intent: z.string().optional(),
  allowWrite: z.boolean().optional(),
  triggerCondition: z.string().optional(),
  triggerResponseIntent: z.string().optional(),
});

const LocalPlaybookSchema = z.object({
  name: z.string().min(1),
  environment: z.object({
    name: z.string().min(1),
    variables: z.record(z.string()).optional(),
  }),
  partition: z.object({
    name: z.string().min(1),
    variables: z.record(z.string()).optional(),
  }).optional(),
  steps: z.array(StepSchema).min(1),
});

type LocalPlaybook = z.infer<typeof LocalPlaybookSchema>;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  subcommand: "run" | null;
  playbookPath: string | null;
  params: Record<string, string>;
  llmKey: string | null;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    subcommand: null,
    playbookPath: null,
    params: {},
    llmKey: null,
    verbose: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "local" && argv[i + 1] === "run") {
      args.subcommand = "run";
      i += 2;
      // Next positional arg is the playbook path
      if (i < argv.length && !argv[i].startsWith("-")) {
        args.playbookPath = argv[i];
        i++;
      }
    } else if (arg === "--param" || arg === "-p") {
      const kv = argv[++i];
      if (kv) {
        const eq = kv.indexOf("=");
        if (eq > 0) {
          args.params[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      i++;
    } else if (arg === "--llm-key") {
      args.llmKey = argv[++i] ?? null;
      i++;
    } else if (arg === "--verbose" || arg === "-v") {
      args.verbose = true;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
    } else {
      i++;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Playbook loading and parameter substitution
// ---------------------------------------------------------------------------

function substituteParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? `{{${key}}}`);
}

function applyParams(playbook: LocalPlaybook, params: Record<string, string>): LocalPlaybook {
  if (Object.keys(params).length === 0) return playbook;
  // Deep-clone via JSON round-trip, then substitute in string fields
  const cloned = JSON.parse(JSON.stringify(playbook)) as LocalPlaybook;
  for (const step of cloned.steps) {
    if (step.intent) step.intent = substituteParams(step.intent, params);
    if (step.triggerCondition) step.triggerCondition = substituteParams(step.triggerCondition, params);
    if (step.triggerResponseIntent) step.triggerResponseIntent = substituteParams(step.triggerResponseIntent, params);
  }
  if (cloned.environment.variables) {
    for (const [k, v] of Object.entries(cloned.environment.variables)) {
      cloned.environment.variables[k] = substituteParams(v, params);
    }
  }
  return cloned;
}

async function loadPlaybook(filePath: string): Promise<LocalPlaybook> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Playbook not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, "utf-8");

  let parsed: unknown;
  if (absPath.endsWith(".json")) {
    parsed = JSON.parse(raw);
  } else {
    // Dynamic import so the yaml dep is only loaded when needed
    const { parse: parseYaml } = await import("yaml");
    parsed = parseYaml(raw);
  }

  const result = LocalPlaybookSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid playbook: ${result.error.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function fmt(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

function printUsage(): void {
  console.log(`
${fmt(BOLD, "synth")} — local operation runner

${fmt(BOLD, "Usage:")}
  synth local run <playbook.yaml> [options]

${fmt(BOLD, "Options:")}
  --param, -p  <key=value>   Substitute {{key}} placeholders in the playbook
  --llm-key    <key>         LLM API key (overrides SYNTH_LLM_API_KEY)
  --verbose, -v              Show full debrief entries after run
  --help, -h                 Show this message

${fmt(BOLD, "Playbook format (YAML):")}

  name: "My pipeline"
  environment:
    name: local
    variables:
      LOG_DIR: /var/log/app
  steps:
    - type: query
      intent: "Check disk usage in {{LOG_DIR}}"
    - type: execute
      intent: "Archive log files older than 30 days in {{LOG_DIR}}"

${fmt(BOLD, "Step types:")}
  deploy       Deploy an artifact to the environment
  maintain     Perform maintenance on existing infrastructure
  query        Survey the environment and produce findings (read-only)
  investigate  Diagnose issues with root-cause analysis (read-only by default)
  execute      Run a general-purpose procedure
  trigger      Install a monitoring-based trigger
  `);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.subcommand) {
    printUsage();
    process.exit(0);
  }

  if (args.subcommand === "run") {
    if (!args.playbookPath) {
      console.error(fmt(RED, "Error: no playbook file specified"));
      console.error(`Usage: synth local run <playbook.yaml>`);
      process.exit(1);
    }

    let playbook: LocalPlaybook;
    try {
      playbook = await loadPlaybook(args.playbookPath);
    } catch (err) {
      console.error(fmt(RED, `Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    playbook = applyParams(playbook, args.params);

    const steps: LocalOperationSpec[] = playbook.steps.map((s) => ({
      type: s.type,
      intent: s.intent,
      allowWrite: s.allowWrite,
      triggerCondition: s.triggerCondition,
      triggerResponseIntent: s.triggerResponseIntent,
    }));

    console.log(`\n${fmt(BOLD, "Synth")} local run: ${fmt(CYAN, playbook.name)}`);
    console.log(`${fmt(DIM, `Environment: ${playbook.environment.name}`)}`);
    if (playbook.partition) {
      console.log(`${fmt(DIM, `Partition: ${playbook.partition.name}`)}`);
    }
    console.log(`${fmt(DIM, `Steps: ${steps.map((s) => s.type).join(" → ")}`)}\n`);

    const executor = new LocalExecutor();
    const result = await executor.run({
      name: playbook.name,
      environment: {
        name: playbook.environment.name,
        variables: playbook.environment.variables,
      },
      partition: playbook.partition
        ? { name: playbook.partition.name, variables: playbook.partition.variables }
        : undefined,
      steps,
      llmApiKey: args.llmKey ?? undefined,
    });

    // Print step results
    for (const sr of result.stepResults) {
      const typeLabel = fmt(DIM, `[${sr.type}]`);
      if (sr.executionSuccess === false) {
        console.log(`  ${fmt(RED, "✗")} ${typeLabel} ${sr.intent}`);
        if (sr.executionError) {
          console.log(`    ${fmt(RED, sr.executionError)}`);
        }
        if (sr.planResult.blocked) {
          console.log(`    ${fmt(YELLOW, "Blocked:")} ${sr.planResult.blockReason}`);
        }
      } else {
        console.log(`  ${fmt(GREEN, "✓")} ${typeLabel} ${sr.intent}`);
        // Show findings summary for query/investigate
        if (sr.planResult.queryFindings) {
          console.log(`    ${fmt(DIM, sr.planResult.queryFindings.summary)}`);
        }
        if (sr.planResult.investigationFindings) {
          console.log(`    ${fmt(DIM, sr.planResult.investigationFindings.summary)}`);
          if (sr.planResult.investigationFindings.rootCause) {
            console.log(`    ${fmt(YELLOW, "Root cause:")} ${sr.planResult.investigationFindings.rootCause}`);
          }
        }
      }
    }

    console.log("");

    // Summary line
    const duration = formatDuration(result.durationMs);
    if (result.success) {
      console.log(`${fmt(GREEN, "✓ Succeeded")} in ${duration} — ${result.stepResults.length} step(s) completed`);
    } else {
      console.log(`${fmt(RED, "✗ Failed")} after ${duration}`);
    }

    // Verbose: print debrief entries
    if (args.verbose && result.debriefEntries.length > 0) {
      console.log(`\n${fmt(BOLD, "Debrief")} (${result.debriefEntries.length} entries):\n`);
      for (const entry of result.debriefEntries) {
        const ts = new Date(entry.timestamp).toISOString().slice(11, 19);
        console.log(`  ${fmt(DIM, ts)} ${fmt(BOLD, entry.decision)}`);
        console.log(`  ${fmt(DIM, entry.reasoning)}\n`);
      }
    }

    process.exit(result.success ? 0 : 1);
  }

  printUsage();
  process.exit(0);
}

main().catch((err) => {
  console.error(fmt(RED, `Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
