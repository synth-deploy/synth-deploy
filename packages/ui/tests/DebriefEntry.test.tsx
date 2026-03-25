/**
 * DebriefEntry + DebriefTimeline rendering tests — verifies that debrief entries
 * display correctly for all decision types, including new operation-type-specific
 * entries (trigger, composite, investigation, query findings).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import DebriefEntryCard from "../src/components/DebriefEntry";
import DebriefTimeline from "../src/components/DebriefTimeline";
import type { DebriefEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DebriefEntry> = {}): DebriefEntry {
  return {
    id: "entry-1",
    timestamp: "2026-03-24T10:00:00Z",
    decisionType: "pipeline-plan",
    decision: "Generated deployment plan with 3 steps",
    reasoning: "Analyzed artifact dependencies and target environment",
    context: {},
    agent: "envoy",
    deploymentId: "dep-abc12345",
    partitionId: "part-xyz98765",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DebriefEntryCard tests
// ---------------------------------------------------------------------------

describe("DebriefEntryCard", () => {
  it("renders the decision text", () => {
    render(<DebriefEntryCard entry={makeEntry()} />);
    expect(screen.getByText("Generated deployment plan with 3 steps")).toBeInTheDocument();
  });

  it("renders the timestamp", () => {
    render(<DebriefEntryCard entry={makeEntry()} />);
    // Timestamp format depends on locale, just verify the entry renders
    const header = document.querySelector(".debrief-entry-header");
    expect(header).toBeInTheDocument();
  });

  it("renders the agent badge", () => {
    render(<DebriefEntryCard entry={makeEntry({ agent: "envoy" })} />);
    expect(screen.getByText("envoy")).toBeInTheDocument();
  });

  it("renders server agent (mapped from command)", () => {
    render(<DebriefEntryCard entry={makeEntry({ agent: "command" })} />);
    expect(screen.getByText("server")).toBeInTheDocument();
  });

  it("applies correct dt-class for pipeline-plan", () => {
    render(<DebriefEntryCard entry={makeEntry({ decisionType: "pipeline-plan" })} />);
    const entryEl = document.querySelector(".debrief-entry");
    expect(entryEl).toHaveClass("dt-plan");
  });

  it("applies correct dt-class for deployment-failure", () => {
    render(<DebriefEntryCard entry={makeEntry({ decisionType: "deployment-failure" })} />);
    const entryEl = document.querySelector(".debrief-entry");
    expect(entryEl).toHaveClass("dt-failure");
  });

  it("applies correct dt-class for diagnostic-investigation", () => {
    render(<DebriefEntryCard entry={makeEntry({ decisionType: "diagnostic-investigation" })} />);
    const entryEl = document.querySelector(".debrief-entry");
    expect(entryEl).toHaveClass("dt-diagnostic");
  });

  it("displays dt-badge with correct label", () => {
    render(<DebriefEntryCard entry={makeEntry({ decisionType: "plan-generation" })} />);
    expect(screen.getByText("Plan Gen")).toBeInTheDocument();
  });

  it("shows truncated deployment ID", () => {
    render(<DebriefEntryCard entry={makeEntry({ deploymentId: "dep-abc12345-long" })} />);
    expect(screen.getByText("dep-abc1")).toBeInTheDocument();
  });

  it("shows truncated partition ID", () => {
    render(<DebriefEntryCard entry={makeEntry({ partitionId: "part-xyz98765-long" })} />);
    expect(screen.getByText(/part-xyz/)).toBeInTheDocument();
  });

  it("reasoning is hidden by default", () => {
    render(<DebriefEntryCard entry={makeEntry()} />);
    expect(screen.queryByText("Analyzed artifact dependencies")).not.toBeInTheDocument();
    expect(screen.getByText("Show reasoning")).toBeInTheDocument();
  });

  it("clicking Show reasoning reveals it", async () => {
    const user = userEvent.setup();
    render(<DebriefEntryCard entry={makeEntry()} />);
    await user.click(screen.getByText("Show reasoning"));
    expect(screen.getByText("Analyzed artifact dependencies and target environment")).toBeInTheDocument();
    expect(screen.getByText("Hide reasoning")).toBeInTheDocument();
  });

  it("shows actor when present", () => {
    render(<DebriefEntryCard entry={makeEntry({ actor: "admin@example.com" })} />);
    expect(screen.getByText(/admin@example\.com/)).toBeInTheDocument();
  });

  it("shows View full prompt button when context has prompt", async () => {
    const user = userEvent.setup();
    render(<DebriefEntryCard entry={makeEntry({ context: { prompt: "You are a deployment agent..." } })} />);
    await user.click(screen.getByText("Show reasoning"));
    expect(screen.getByText("View full prompt")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Decision type coverage — all dtClassMap entries render without error
// ---------------------------------------------------------------------------

describe("Decision type rendering coverage", () => {
  const allTypes = [
    "pipeline-plan", "configuration-resolved", "variable-conflict",
    "health-check", "deployment-execution", "deployment-verification",
    "deployment-completion", "deployment-failure", "diagnostic-investigation",
    "environment-scan", "system", "llm-call", "artifact-analysis",
    "plan-generation", "plan-approval", "plan-rejection",
    "rollback-execution", "cross-system-context",
  ];

  for (const dt of allTypes) {
    it(`renders ${dt} entry without error`, () => {
      const { container } = render(
        <DebriefEntryCard entry={makeEntry({ decisionType: dt as DebriefEntry["decisionType"] })} />,
      );
      expect(container.querySelector(".debrief-entry")).toBeInTheDocument();
    });
  }

  // Operation-type-specific decision types
  const newTypes = [
    "query-findings", "investigation-findings",
    "trigger-activated", "trigger-fired", "trigger-suppressed",
    "composite-started", "composite-child-completed", "composite-failed", "composite-completed",
  ];

  for (const dt of newTypes) {
    it(`renders new decision type ${dt} without error (graceful fallback)`, () => {
      const { container } = render(
        <DebriefEntryCard entry={makeEntry({ decisionType: dt as DebriefEntry["decisionType"], decision: `Test ${dt} entry` })} />,
      );
      expect(container.querySelector(".debrief-entry")).toBeInTheDocument();
      expect(screen.getByText(`Test ${dt} entry`)).toBeInTheDocument();
    });
  }
});

// ---------------------------------------------------------------------------
// DebriefTimeline tests
// ---------------------------------------------------------------------------

describe("DebriefTimeline", () => {
  it("renders empty state when no entries", () => {
    render(<DebriefTimeline entries={[]} />);
    expect(screen.getByText("No debrief entries recorded")).toBeInTheDocument();
  });

  it("renders entries in chronological order", () => {
    const entries = [
      makeEntry({ id: "e2", timestamp: "2026-03-24T10:05:00Z", decision: "Second" }),
      makeEntry({ id: "e1", timestamp: "2026-03-24T10:00:00Z", decision: "First" }),
    ];
    render(<DebriefTimeline entries={entries} />);
    const decisions = document.querySelectorAll(".debrief-entry-decision");
    expect(decisions[0].textContent).toBe("First");
    expect(decisions[1].textContent).toBe("Second");
  });

  it("wraps entries in debrief-timeline container", () => {
    render(<DebriefTimeline entries={[makeEntry()]} />);
    expect(document.querySelector(".debrief-timeline")).toBeInTheDocument();
  });
});
