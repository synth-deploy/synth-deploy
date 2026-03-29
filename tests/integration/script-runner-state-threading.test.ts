/**
 * Integration tests for per-step script execution with real cwd/env
 * state threading. These tests run actual bash processes to verify
 * the state capture and injection mechanism works end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScriptedPlan, PlanStep } from "@synth-deploy/core";
import { ScriptRunner } from "@synth-deploy/envoy/execution/script-runner.js";
import type { ScriptProgressEvent } from "@synth-deploy/envoy/execution/script-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makePlan(steps: PlanStep[]): ScriptedPlan {
  return {
    platform: "bash",
    reasoning: "test plan",
    steps,
  };
}

function step(description: string, script: string, opts?: Partial<PlanStep>): PlanStep {
  return {
    description,
    script,
    dryRunScript: opts?.dryRunScript ?? null,
    rollbackScript: opts?.rollbackScript ?? null,
    reversible: opts?.reversible ?? true,
  };
}

function collectEvents(runner: ScriptRunner, plan: ScriptedPlan): {
  events: ScriptProgressEvent[];
  run: () => ReturnType<ScriptRunner["executePlan"]>;
} {
  const events: ScriptProgressEvent[] = [];
  return {
    events,
    run: () => runner.executePlan(plan, "test-op", (e) => events.push(e)),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-runner-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScriptRunner state threading", () => {
  const runner = new ScriptRunner("darwin", 30_000);

  describe("cwd threading", () => {
    it("step 2 inherits cwd from step 1's cd", async () => {
      const subDir = path.join(tmpDir, "cwd-test");
      const plan = makePlan([
        step("create and cd into subdir", `mkdir -p "${subDir}" && cd "${subDir}"`),
        step("verify cwd is subdir", `pwd && test "$(pwd)" = "${subDir}"`),
      ]);

      const result = await runner.executePlan(plan, "test-cwd");

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(2);
      expect(result.stepResults[0].cwdAfter).toBe(subDir);
      expect(result.stepResults[1].result.stdout).toContain(subDir);
    });

    it("cwd threads across three steps", async () => {
      const a = path.join(tmpDir, "chain-a");
      const b = path.join(tmpDir, "chain-a", "chain-b");
      const plan = makePlan([
        step("create dir a", `mkdir -p "${a}" && cd "${a}"`),
        step("create dir b relative to a", `mkdir -p chain-b && cd chain-b`),
        step("verify absolute path", `test "$(pwd)" = "${b}" && echo "ok"`),
      ]);

      const result = await runner.executePlan(plan, "test-cwd-chain");

      expect(result.success).toBe(true);
      expect(result.stepResults[0].cwdAfter).toBe(a);
      expect(result.stepResults[1].cwdAfter).toBe(b);
      expect(result.stepResults[2].result.stdout).toContain("ok");
    });
  });

  describe("env threading", () => {
    it("step 2 sees env var exported in step 1", async () => {
      const plan = makePlan([
        step("export var", `export SYNTH_TEST_VAR=hello_from_step1`),
        step("read var", `echo "val=$SYNTH_TEST_VAR" && test "$SYNTH_TEST_VAR" = "hello_from_step1"`),
      ]);

      const result = await runner.executePlan(plan, "test-env");

      expect(result.success).toBe(true);
      expect(result.stepResults[0].envDelta).toHaveProperty("SYNTH_TEST_VAR", "hello_from_step1");
      expect(result.stepResults[1].result.stdout).toContain("val=hello_from_step1");
    });

    it("env vars accumulate across steps", async () => {
      const plan = makePlan([
        step("set var A", `export SYNTH_A=alpha`),
        step("set var B, check A", `export SYNTH_B=bravo && echo "A=$SYNTH_A"`),
        step("check both", `test "$SYNTH_A" = "alpha" && test "$SYNTH_B" = "bravo" && echo "both_ok"`),
      ]);

      const result = await runner.executePlan(plan, "test-env-accumulate");

      expect(result.success).toBe(true);
      expect(result.stepResults[1].result.stdout).toContain("A=alpha");
      expect(result.stepResults[2].result.stdout).toContain("both_ok");
    });

    it("env var override in later step takes effect", async () => {
      const plan = makePlan([
        step("set var", `export SYNTH_OVERRIDE=original`),
        step("override var", `export SYNTH_OVERRIDE=updated`),
        step("check override", `test "$SYNTH_OVERRIDE" = "updated" && echo "override_ok"`),
      ]);

      const result = await runner.executePlan(plan, "test-env-override");

      expect(result.success).toBe(true);
      expect(result.stepResults[2].result.stdout).toContain("override_ok");
    });
  });

  describe("combined cwd + env threading", () => {
    it("step 2 gets both cwd and env from step 1", async () => {
      const subDir = path.join(tmpDir, "combined-test");
      const plan = makePlan([
        step("setup", `mkdir -p "${subDir}" && cd "${subDir}" && export SYNTH_COMBO=works`),
        step("verify both", `test "$(pwd)" = "${subDir}" && test "$SYNTH_COMBO" = "works" && echo "combined_ok"`),
      ]);

      const result = await runner.executePlan(plan, "test-combined");

      expect(result.success).toBe(true);
      expect(result.stepResults[1].result.stdout).toContain("combined_ok");
    });
  });

  describe("output cleanliness", () => {
    it("internal markers are stripped from step output", async () => {
      const plan = makePlan([
        step("echo something", `echo "user_visible_output"`),
      ]);

      const result = await runner.executePlan(plan, "test-clean-output");

      expect(result.success).toBe(true);
      expect(result.stepResults[0].result.stdout).toBe("user_visible_output");
      expect(result.stepResults[0].result.stdout).not.toContain("##SYNTH_INTERNAL");
    });

    it("multi-line output is preserved without markers", async () => {
      const plan = makePlan([
        step("multi-line", `echo "line1"\necho "line2"\necho "line3"`),
      ]);

      const result = await runner.executePlan(plan, "test-multiline");

      expect(result.success).toBe(true);
      expect(result.stepResults[0].result.stdout).toBe("line1\nline2\nline3");
      expect(result.stepResults[0].result.stdout).not.toContain("##SYNTH_INTERNAL");
    });

    it("progress events do not contain internal markers", async () => {
      const plan = makePlan([
        step("echo", `echo "visible" && export SYNTH_HIDDEN=yes && cd /tmp`),
      ]);

      const { events, run } = collectEvents(runner, plan);
      await run();

      const outputEvents = events.filter((e) => e.type === "step-output");
      for (const e of outputEvents) {
        expect(e.output).not.toContain("##SYNTH_INTERNAL");
      }
    });
  });

  describe("progress events", () => {
    it("emits correct sequence for a 3-step plan", async () => {
      const plan = makePlan([
        step("step one", `echo "s1"`),
        step("step two", `echo "s2"`),
        step("step three", `echo "s3"`),
      ]);

      const { events, run } = collectEvents(runner, plan);
      await run();

      const typeSeq = events.map((e) => e.type);
      // Each step: started, output(s), completed. Then execution-completed.
      expect(typeSeq.filter((t) => t === "plan-step-started")).toHaveLength(3);
      expect(typeSeq.filter((t) => t === "plan-step-completed")).toHaveLength(3);
      expect(typeSeq[typeSeq.length - 1]).toBe("execution-completed");

      // stepIndex increments
      const starts = events.filter((e) => e.type === "plan-step-started");
      expect(starts.map((e) => e.stepIndex)).toEqual([0, 1, 2]);
    });
  });

  describe("failure and rollback", () => {
    it("stops on failure and rolls back completed steps", async () => {
      const marker = path.join(tmpDir, "rollback-marker.txt");
      const plan = makePlan([
        step(
          "create marker",
          `echo "created" > "${marker}"`,
          { rollbackScript: `rm -f "${marker}"`, reversible: true },
        ),
        step("fail intentionally", `exit 1`),
      ]);

      // Marker should exist after step 1, be removed after rollback
      const result = await runner.executePlan(plan, "test-rollback");

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(2);
      expect(result.stepResults[0].result.success).toBe(true);
      expect(result.stepResults[1].result.success).toBe(false);
      expect(result.rollbackStepResults).toHaveLength(1);
      expect(result.rollbackStepResults![0].result.success).toBe(true);
      // Marker file should be cleaned up by rollback
      expect(fs.existsSync(marker)).toBe(false);
    });

    it("rollback receives correct cwd context from its step", async () => {
      const subDir = path.join(tmpDir, "rollback-cwd");
      const rollbackLog = path.join(tmpDir, "rollback-cwd-log.txt");
      const plan = makePlan([
        step(
          "cd into subdir",
          `mkdir -p "${subDir}" && cd "${subDir}"`,
          { rollbackScript: `pwd > "${rollbackLog}"`, reversible: true },
        ),
        step("fail", `exit 1`),
      ]);

      await runner.executePlan(plan, "test-rollback-cwd");

      // The rollback script should have run in the cwd captured after step 0
      expect(fs.existsSync(rollbackLog)).toBe(true);
      const rollbackCwd = fs.readFileSync(rollbackLog, "utf-8").trim();
      expect(rollbackCwd).toBe(subDir);
      fs.unlinkSync(rollbackLog);
    });

    it("skips non-reversible steps during rollback", async () => {
      const plan = makePlan([
        step("reversible step", `echo "r"`, { rollbackScript: `echo "rolled back"`, reversible: true }),
        step("non-reversible step", `echo "nr"`, { reversible: false }),
        step("fail", `exit 1`),
      ]);

      const { events, run } = collectEvents(runner, plan);
      const result = await run();

      expect(result.success).toBe(false);
      expect(result.rollbackStepResults).toHaveLength(1);
      // Only step 0 rolled back (step 1 is non-reversible)
      expect(result.rollbackStepResults![0].stepIndex).toBe(0);

      const skipped = events.filter((e) => e.type === "rollback-step-skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0].stepIndex).toBe(1);
    });
  });

  describe("dry-run", () => {
    it("runs per-step dry-run with state threading", async () => {
      const subDir = path.join(tmpDir, "dryrun-state");
      const plan = makePlan([
        step("check parent writable", `echo "ok"`, {
          dryRunScript: `mkdir -p "${subDir}" && cd "${subDir}"`,
        }),
        step("check subdir exists", `echo "ok"`, {
          dryRunScript: `test "$(pwd)" = "${subDir}" && echo "dryrun_cwd_ok"`,
        }),
      ]);

      const results = await runner.executeDryRunPlan(plan, "test-dryrun");

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe("passed");
      expect(results[1].status).toBe("passed");
      expect(results[1].result?.stdout).toContain("dryrun_cwd_ok");
    });

    it("continues past dry-run failures to report all issues", async () => {
      const plan = makePlan([
        step("passing step", `echo "ok"`, { dryRunScript: `echo "pass"` }),
        step("failing step", `echo "ok"`, { dryRunScript: `exit 1` }),
        step("another passing", `echo "ok"`, { dryRunScript: `echo "also pass"` }),
      ]);

      const results = await runner.executeDryRunPlan(plan, "test-dryrun-continue");

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("passed");
      expect(results[1].status).toBe("failed");
      expect(results[2].status).toBe("passed");
    });

    it("skips steps without dryRunScript", async () => {
      const plan = makePlan([
        step("has dry-run", `echo "ok"`, { dryRunScript: `echo "checked"` }),
        step("no dry-run", `echo "ok"`),
        step("also has dry-run", `echo "ok"`, { dryRunScript: `echo "checked too"` }),
      ]);

      const results = await runner.executeDryRunPlan(plan, "test-dryrun-skip");

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("passed");
      expect(results[1].status).toBe("skipped");
      expect(results[2].status).toBe("passed");
    });
  });

  describe("edge cases", () => {
    it("handles script that outputs text resembling internal markers", async () => {
      const plan = makePlan([
        step("sneaky output", `echo "##SYNTH_INTERNAL_CWD:/fake/path"\necho "real output"`),
      ]);

      const result = await runner.executePlan(plan, "test-sneaky");

      // The runner's own markers are appended AFTER the script, so the last
      // occurrence wins. The fake marker in the script output should be
      // stripped along with everything after it, but the real cwd capture
      // at the end determines the actual state.
      expect(result.success).toBe(true);
      // cwd should be the real cwd, not /fake/path
      expect(result.stepResults[0].cwdAfter).not.toBe("/fake/path");
    });

    it("handles empty script output", async () => {
      const plan = makePlan([
        step("silent step", `true`),
        step("check state still threads", `echo "after_silent"`),
      ]);

      const result = await runner.executePlan(plan, "test-silent");

      expect(result.success).toBe(true);
      expect(result.stepResults[1].result.stdout).toContain("after_silent");
    });

    it("handles single-step plan", async () => {
      const plan = makePlan([
        step("only step", `echo "solo"`),
      ]);

      const result = await runner.executePlan(plan, "test-single");

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults[0].result.stdout).toContain("solo");
    });

    it("handles empty plan", async () => {
      const plan = makePlan([]);

      const result = await runner.executePlan(plan, "test-empty");

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(0);
    });
  });
});
