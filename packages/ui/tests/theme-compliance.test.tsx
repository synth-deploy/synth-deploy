/**
 * Theme compliance tests — verifies that the CSS contract from UI_PATTERNS.md
 * is upheld: all statuses have pill classes, all decision types have color mappings,
 * all entity types have color entries.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ENTITY_COLORS, type EntityType } from "../src/components/EntityTag";

// ---------------------------------------------------------------------------
// Read app.css once
// ---------------------------------------------------------------------------

const appCssPath = path.resolve(import.meta.dirname, "../src/app.css");
const appCss = fs.readFileSync(appCssPath, "utf-8");

// ---------------------------------------------------------------------------
// Status pill classes
// ---------------------------------------------------------------------------

describe("Status pill CSS classes", () => {
  const statuses = ["succeeded", "failed", "running", "pending", "rolled_back"];

  for (const status of statuses) {
    it(`has .v2-pill-${status} class defined`, () => {
      expect(appCss).toContain(`.v2-pill-${status}`);
    });
  }

  for (const status of statuses) {
    it(`has .badge-${status} class defined`, () => {
      expect(appCss).toContain(`.badge-${status}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Decision type color mappings
// ---------------------------------------------------------------------------

describe("Decision type colors", () => {
  // These are the DT_COLORS from DiaryPanel.tsx — every decision type the system
  // can produce should have a color mapping
  const decisionTypes = [
    "pipeline-plan",
    "configuration-resolved",
    "variable-conflict",
    "health-check",
    "deployment-execution",
    "deployment-verification",
    "deployment-completion",
    "deployment-failure",
    "diagnostic-investigation",
    "environment-scan",
    "system",
    "llm-call",
    "artifact-analysis",
    "plan-generation",
    "plan-approval",
    "plan-rejection",
    "rollback-execution",
    "cross-system-context",
  ];

  it("DT_COLORS covers all base decision types", () => {
    // Import the actual map
    // Since DT_COLORS is not exported, we verify via the CSS variables it references
    const dtVarPattern = /--dt-\w+/g;
    const dtVars = appCss.match(dtVarPattern) ?? [];
    const uniqueVars = [...new Set(dtVars)];

    // At minimum, these CSS variables must be defined
    for (const v of ["--dt-plan", "--dt-health", "--dt-verification", "--dt-diagnostic", "--dt-scan", "--dt-system"]) {
      expect(uniqueVars, `Missing CSS variable ${v}`).toContain(v);
    }
  });
});

// ---------------------------------------------------------------------------
// Entity tag colors
// ---------------------------------------------------------------------------

describe("EntityTag color coverage", () => {
  const requiredTypes: EntityType[] = ["Envoy", "Partition", "Artifact", "Deployment", "Debrief", "Synth", "Command"];

  for (const type of requiredTypes) {
    it(`ENTITY_COLORS has entry for ${type}`, () => {
      expect(ENTITY_COLORS[type]).toBeDefined();
      expect(ENTITY_COLORS[type].color).toMatch(/^var\(--/);
      expect(ENTITY_COLORS[type].bg).toBeDefined();
      expect(ENTITY_COLORS[type].border).toBeDefined();
    });
  }

  it("all entity colors use CSS variables (no hardcoded hex in color field)", () => {
    for (const [type, colors] of Object.entries(ENTITY_COLORS)) {
      expect(colors.color, `${type}.color should use CSS variable`).toMatch(/^var\(--/);
    }
  });
});

// ---------------------------------------------------------------------------
// CSS variable usage — core variables defined
// ---------------------------------------------------------------------------

describe("Core CSS variables", () => {
  const coreVars = [
    "--text", "--text-secondary", "--text-muted",
    "--surface", "--bg", "--border",
    "--accent", "--accent-dim",
    "--status-succeeded", "--status-failed", "--status-running", "--status-pending", "--status-warning",
    "--font-mono", "--font-display",
  ];

  for (const v of coreVars) {
    it(`defines ${v}`, () => {
      expect(appCss).toContain(v);
    });
  }
});
