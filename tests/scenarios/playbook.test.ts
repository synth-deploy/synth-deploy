/**
 * Playbook vitest integration — dynamically discovers all playbook YAML files
 * and creates a test case per playbook. Automatically included by
 * `npm run test:scenarios` via the existing vitest config glob.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import type { ScenarioHarness } from "./harness.js";
import { createHarness, teardownHarness } from "./harness.js";
import { discoverPlaybooks, runPlaybook } from "../playbooks/runner.js";

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

let h: ScenarioHarness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await teardownHarness(h);
});

// ---------------------------------------------------------------------------
// Discover and run playbooks
// ---------------------------------------------------------------------------

const playbookDir = path.resolve(import.meta.dirname, "../playbooks");
const playbooks = discoverPlaybooks(playbookDir);

describe("Playbooks", () => {
  if (playbooks.length === 0) {
    it.skip("no playbooks found", () => {});
    return;
  }

  for (const pb of playbooks) {
    it(`${pb.name} [${pb.type}]`, async () => {
      const result = await runPlaybook(h, pb.path);

      if (result.error) {
        expect.fail(`Playbook error: ${result.error}`);
      }

      for (const a of result.assertions) {
        expect(a.passed, a.message).toBe(true);
      }
    });
  }
});
