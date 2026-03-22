import { describe, it, expect } from "vitest";
import { formatDebriefEntry, formatDebriefEntries } from "../src/debrief-formatter.js";
import type { DebriefEntry } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DebriefEntry> = {}): DebriefEntry {
  return {
    id: "entry-1",
    timestamp: new Date("2026-03-01T14:30:45.123Z"),
    partitionId: "partition-acme",
    operationId: "deploy-abcdef1234567890",
    agent: "server",
    decisionType: "pipeline-plan",
    decision: "Deploy web-app v2.1.0 to production",
    reasoning: "All preconditions met. Health check passed.",
    context: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatDebriefEntry — basic formatting
// ---------------------------------------------------------------------------

describe("formatDebriefEntry — basic formatting", () => {
  it("formats timestamp as ISO without milliseconds with UTC suffix", () => {
    const output = formatDebriefEntry(makeEntry());
    expect(output).toContain("2026-03-01 14:30:45 UTC");
  });

  it("uppercases the decision type", () => {
    const output = formatDebriefEntry(makeEntry({ decisionType: "deployment-failure" }));
    expect(output).toContain("DEPLOYMENT-FAILURE");
  });

  it("includes partition ID on the detail line", () => {
    const output = formatDebriefEntry(makeEntry());
    expect(output).toContain("Partition: partition-acme");
  });

  it("truncates deployment ID to first 8 characters", () => {
    const output = formatDebriefEntry(makeEntry());
    expect(output).toContain("Deployment: deploy-a");
    expect(output).not.toContain("deploy-abcdef1234567890");
  });

  it("includes agent name", () => {
    const output = formatDebriefEntry(makeEntry({ agent: "envoy" }));
    expect(output).toContain("Agent: envoy");
  });

  it("includes the decision text", () => {
    const output = formatDebriefEntry(makeEntry());
    expect(output).toContain("Decision: Deploy web-app v2.1.0 to production");
  });

  it("includes the reasoning text", () => {
    const output = formatDebriefEntry(makeEntry());
    expect(output).toContain("Reasoning: All preconditions met. Health check passed.");
  });
});

// ---------------------------------------------------------------------------
// formatDebriefEntry — null/missing fields
// ---------------------------------------------------------------------------

describe("formatDebriefEntry — null/missing fields", () => {
  it("shows 'system' when partitionId is null", () => {
    const output = formatDebriefEntry(makeEntry({ partitionId: null }));
    expect(output).toContain("Partition: system");
  });

  it("shows 'n/a' when operationId is null", () => {
    const output = formatDebriefEntry(makeEntry({ operationId: null }));
    expect(output).toContain("Deployment: n/a");
  });

  it("handles both partitionId and operationId being null", () => {
    const output = formatDebriefEntry(makeEntry({ partitionId: null, operationId: null }));
    expect(output).toContain("Partition: system");
    expect(output).toContain("Deployment: n/a");
  });
});

// ---------------------------------------------------------------------------
// formatDebriefEntry — context rendering
// ---------------------------------------------------------------------------

describe("formatDebriefEntry — context rendering", () => {
  it("omits Context line when context is empty", () => {
    const output = formatDebriefEntry(makeEntry({ context: {} }));
    expect(output).not.toContain("Context:");
  });

  it("renders simple key=value pairs", () => {
    const output = formatDebriefEntry(makeEntry({
      context: { step: "health-check", retries: 3 },
    }));
    expect(output).toContain("Context:");
    expect(output).toContain("step=health-check");
    expect(output).toContain("retries=3");
  });

  it("renders object values as JSON", () => {
    const output = formatDebriefEntry(makeEntry({
      context: { config: { port: 3000, host: "localhost" } },
    }));
    expect(output).toContain("Context:");
    expect(output).toContain('config={"port":3000,"host":"localhost"}');
  });

  it("renders null context values directly", () => {
    const output = formatDebriefEntry(makeEntry({
      context: { previousVersion: null as unknown },
    }));
    expect(output).toContain("previousVersion=null");
  });

  it("handles multiple context keys separated by commas", () => {
    const output = formatDebriefEntry(makeEntry({
      context: { a: "1", b: "2", c: "3" },
    }));
    expect(output).toContain("a=1, b=2, c=3");
  });
});

// ---------------------------------------------------------------------------
// formatDebriefEntry — long reasoning strings
// ---------------------------------------------------------------------------

describe("formatDebriefEntry — long reasoning strings", () => {
  it("preserves the full reasoning text without truncation", () => {
    const longReasoning = "A".repeat(5000);
    const output = formatDebriefEntry(makeEntry({ reasoning: longReasoning }));
    expect(output).toContain(`Reasoning: ${longReasoning}`);
  });

  it("preserves multi-line reasoning intact", () => {
    const multiLine = "Line one.\nLine two.\nLine three.";
    const output = formatDebriefEntry(makeEntry({ reasoning: multiLine }));
    expect(output).toContain(`Reasoning: ${multiLine}`);
  });
});

// ---------------------------------------------------------------------------
// formatDebriefEntry — special characters
// ---------------------------------------------------------------------------

describe("formatDebriefEntry — special characters", () => {
  it("handles unicode characters in decision text", () => {
    const output = formatDebriefEntry(makeEntry({
      decision: "Deploy to production \u2014 verified \u2713",
    }));
    expect(output).toContain("Decision: Deploy to production \u2014 verified \u2713");
  });

  it("handles quotes in reasoning", () => {
    const output = formatDebriefEntry(makeEntry({
      reasoning: 'Service returned "503 Service Unavailable"',
    }));
    expect(output).toContain('Reasoning: Service returned "503 Service Unavailable"');
  });

  it("handles newlines in context values", () => {
    const output = formatDebriefEntry(makeEntry({
      context: { errorMsg: "line1\nline2" },
    }));
    expect(output).toContain("Context:");
    expect(output).toContain("errorMsg=line1\nline2");
  });

  it("handles angle brackets and ampersands in decision", () => {
    const output = formatDebriefEntry(makeEntry({
      decision: "Compare <old> & <new> versions",
    }));
    expect(output).toContain("Decision: Compare <old> & <new> versions");
  });
});

// ---------------------------------------------------------------------------
// formatDebriefEntries — multiple entries
// ---------------------------------------------------------------------------

describe("formatDebriefEntries — multiple entries", () => {
  it("returns 'No debrief entries found.' for an empty array", () => {
    expect(formatDebriefEntries([])).toBe("No debrief entries found.");
  });

  it("formats a single entry without separators", () => {
    const output = formatDebriefEntries([makeEntry()]);
    expect(output).not.toContain("---");
    expect(output).toContain("PIPELINE-PLAN");
  });

  it("separates multiple entries with ---", () => {
    const entries = [
      makeEntry({ id: "e1", decisionType: "pipeline-plan" }),
      makeEntry({ id: "e2", decisionType: "deployment-failure" }),
      makeEntry({ id: "e3", decisionType: "system" }),
    ];
    const output = formatDebriefEntries(entries);
    const separators = output.split("---").length - 1;
    expect(separators).toBe(2);
  });

  it("includes all entries in the output", () => {
    const entries = [
      makeEntry({ id: "e1", decision: "First decision" }),
      makeEntry({ id: "e2", decision: "Second decision" }),
    ];
    const output = formatDebriefEntries(entries);
    expect(output).toContain("First decision");
    expect(output).toContain("Second decision");
  });

  it("preserves entry order from the input array", () => {
    const entries = [
      makeEntry({ id: "e1", decision: "ALPHA" }),
      makeEntry({ id: "e2", decision: "BRAVO" }),
      makeEntry({ id: "e3", decision: "CHARLIE" }),
    ];
    const output = formatDebriefEntries(entries);
    const alphaIdx = output.indexOf("ALPHA");
    const bravoIdx = output.indexOf("BRAVO");
    const charlieIdx = output.indexOf("CHARLIE");
    expect(alphaIdx).toBeLessThan(bravoIdx);
    expect(bravoIdx).toBeLessThan(charlieIdx);
  });
});
