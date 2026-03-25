/**
 * Operation authoring panel tests — verifies the form logic and field visibility
 * for all 6 operation types (deploy, maintain, query, investigate, trigger, composite).
 */
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CanvasProvider } from "../src/context/CanvasContext";

// ---------------------------------------------------------------------------
// Mocks — must come before component import
// ---------------------------------------------------------------------------

const mockPushPanel = vi.fn();

vi.mock("../src/context/CanvasContext", async () => {
  const actual = await vi.importActual("../src/context/CanvasContext");
  return {
    ...actual,
    useCanvas: () => ({
      pushPanel: mockPushPanel,
      popPanel: vi.fn(),
      replacePanel: vi.fn(),
      resetToOverview: vi.fn(),
      panels: [],
      currentPanel: { id: "1", type: "operation-authoring", title: "New", params: {} },
      depth: 1,
      minimizedDeployment: null,
      minimizeDeployment: vi.fn(),
      restoreDeployment: vi.fn(),
      clearMinimizedDeployment: vi.fn(),
    }),
  };
});

vi.mock("../src/context/SettingsContext", () => ({
  useSettings: () => ({
    settings: { environmentsEnabled: true, approvalDefaults: undefined },
    loading: false,
    refresh: vi.fn(),
  }),
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockArtifacts = [
  { id: "art-1", name: "web-app", type: "docker-image", analysis: { summary: "A web app", dependencies: [], configurationExpectations: {}, confidence: 0.9 }, annotations: [], learningHistory: [], createdAt: new Date(), updatedAt: new Date() },
];
const mockEnvironments = [
  { id: "env-1", name: "production", variables: { APP_ENV: "production" }, createdAt: new Date(), updatedAt: new Date() },
];
const mockPartitions = [
  { id: "part-1", name: "AcmeCorp", variables: { DB_HOST: "acme-db" }, createdAt: new Date(), updatedAt: new Date() },
];

vi.mock("../src/hooks/useQuery", () => ({
  useQuery: (key: string) => {
    if (key === "list:artifacts") return { data: mockArtifacts, loading: false };
    if (key === "list:partitions") return { data: mockPartitions, loading: false };
    if (key === "list:environments") return { data: mockEnvironments, loading: false };
    if (key.startsWith("list:envoys")) return { data: [], loading: false };
    if (key === "list:deployments") return { data: [], loading: false };
    return { data: null, loading: false };
  },
  invalidate: vi.fn(),
  invalidateExact: vi.fn(),
}));

vi.mock("../src/api", () => ({
  listArtifacts: vi.fn(),
  listPartitions: vi.fn(),
  listEnvironments: vi.fn(),
  listEnvoys: vi.fn().mockResolvedValue([]),
  listDeployments: vi.fn(),
  createOperation: vi.fn().mockResolvedValue({ deployment: { id: "op-123" } }),
  recordPreFlightResponse: vi.fn().mockResolvedValue({}),
  getPreFlightContext: vi.fn().mockResolvedValue({
    recommendation: { action: "proceed", reasoning: "All clear", confidence: 0.95 },
    targetHealth: { status: "healthy", details: "All targets healthy" },
    recentHistory: { recentFailures: 0, deploymentsToday: 0 },
    crossSystemContext: [],
    llmAvailable: true,
  }),
}));

import { createOperation } from "../src/api";
import OperationAuthoringPanel from "../src/components/canvas/DeploymentAuthoringPanel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPanel(props: Partial<Parameters<typeof OperationAuthoringPanel>[0]> = {}) {
  return render(
    <CanvasProvider>
      <OperationAuthoringPanel title="New Operation" {...props} />
    </CanvasProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OperationAuthoringPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("operation type selector", () => {
    it("renders all 6 operation type buttons", () => {
      renderPanel();
      for (const type of ["deploy", "maintain", "query", "investigate", "trigger", "composite"]) {
        expect(screen.getByText(type)).toBeInTheDocument();
      }
    });

    it("defaults to deploy type", () => {
      renderPanel();
      const deployBtn = screen.getByText("deploy");
      // Active button has accent background (checked via inline style)
      expect(deployBtn.style.background).toContain("var(--accent)");
    });

    it("respects preselectedOpType prop", () => {
      renderPanel({ preselectedOpType: "query" });
      const queryBtn = screen.getByText("query");
      expect(queryBtn.style.background).toContain("var(--accent)");
    });
  });

  describe("deploy type", () => {
    it("shows artifact selection and target selection", () => {
      renderPanel();
      expect(screen.getByText("What")).toBeInTheDocument();
      expect(screen.getByText("web-app")).toBeInTheDocument();
    });

    it("does not show Objective field for deploy", () => {
      renderPanel();
      expect(screen.queryByText("Objective (optional)")).not.toBeInTheDocument();
      expect(screen.queryByText("Objective")).not.toBeInTheDocument();
    });
  });

  describe("maintain type", () => {
    it("shows required Objective field when maintain is selected", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("maintain"));
      expect(screen.getByText("Objective")).toBeInTheDocument();
      expect(screen.queryByText("Objective (optional)")).not.toBeInTheDocument();
    });

    it("hides artifact picker for maintain", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("maintain"));
      expect(screen.queryByText("What")).not.toBeInTheDocument();
    });
  });

  describe("query type", () => {
    it("shows required Objective field", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("query"));
      expect(screen.getByText("Objective")).toBeInTheDocument();
    });

    it("does not show allowWrite toggle", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("query"));
      expect(screen.queryByText(/allow write/i)).not.toBeInTheDocument();
    });
  });

  describe("investigate type", () => {
    it("shows allowWrite toggle", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("investigate"));
      expect(screen.getByText(/allow write access/i)).toBeInTheDocument();
    });

    it("allowWrite toggle defaults to unchecked", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("investigate"));
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).not.toBeChecked();
    });

    it("allowWrite toggle can be checked", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("investigate"));
      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);
      expect(checkbox).toBeChecked();
    });
  });

  describe("trigger type", () => {
    it("shows condition and response intent fields", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("trigger"));
      expect(screen.getByText("Condition")).toBeInTheDocument();
      expect(screen.getByText("Response")).toBeInTheDocument();
    });

    it("hides the generic Objective field", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("trigger"));
      expect(screen.queryByText("Objective")).not.toBeInTheDocument();
    });

    it("respects preselected trigger values", () => {
      renderPanel({
        preselectedOpType: "trigger",
        preselectedTriggerCondition: "disk > 85",
        preselectedTriggerResponseIntent: "run cleanup",
      });
      const textareas = screen.getAllByRole("textbox");
      expect(textareas.some((t) => (t as HTMLTextAreaElement).value === "disk > 85")).toBe(true);
      expect(textareas.some((t) => (t as HTMLTextAreaElement).value === "run cleanup")).toBe(true);
    });
  });

  describe("composite type", () => {
    it("shows child operation builder with Add button", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("composite"));
      expect(screen.getByText(/add operation/i)).toBeInTheDocument();
    });

    it("starts with no children and shows empty message", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("composite"));
      expect(screen.getByText(/no operations added/i)).toBeInTheDocument();
    });

    it("adds a child operation when Add is clicked", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("composite"));
      await user.click(screen.getByText(/add operation/i));
      expect(screen.queryByText(/no operations added/i)).not.toBeInTheDocument();
      // Should show the child type selector
      expect(screen.getByText("1.")).toBeInTheDocument();
    });

    it("child type selector includes deploy, maintain, query, investigate", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("composite"));
      await user.click(screen.getByText(/add operation/i));
      const select = screen.getByRole("combobox");
      const options = within(select).getAllByRole("option");
      const values = options.map((o) => (o as HTMLOptionElement).value);
      expect(values).toContain("deploy");
      expect(values).toContain("maintain");
      expect(values).toContain("query");
      expect(values).toContain("investigate");
    });

    it("child can be removed", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("composite"));
      await user.click(screen.getByText(/add operation/i));
      expect(screen.getByText("1.")).toBeInTheDocument();
      await user.click(screen.getByText("✕"));
      expect(screen.queryByText("1.")).not.toBeInTheDocument();
    });

    it("hides generic Objective for composite", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("composite"));
      expect(screen.queryByText("Objective")).not.toBeInTheDocument();
    });
  });

  describe("preselection props", () => {
    it("preselectedIntent populates the intent field", () => {
      renderPanel({ preselectedOpType: "maintain", preselectedIntent: "Rotate API keys" });
      const textarea = screen.getByRole("textbox");
      expect((textarea as HTMLTextAreaElement).value).toBe("Rotate API keys");
    });
  });

  describe("submission journeys", () => {
    // 1. Deploy happy path
    it("deploy: selecting artifact + environment + submitting calls createOperation and navigates to plan-review", async () => {
      const user = userEvent.setup();
      renderPanel();
      // Select artifact
      await user.click(screen.getByText("web-app"));
      // Switch scope from envoy (default) to environment, then select
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      // Click submit
      await user.click(screen.getByText("Request Plan"));
      await waitFor(() => {
        expect(createOperation).toHaveBeenCalledWith(
          expect.objectContaining({
            artifactId: "art-1",
            environmentId: "env-1",
            type: "deploy",
          }),
        );
      });
      expect(mockPushPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "plan-review",
          params: { id: "op-123" },
        }),
      );
    });

    // 2. Deploy missing artifact — action bar not rendered
    it("deploy: action bar is not shown without artifact selection", () => {
      renderPanel();
      expect(screen.queryByText("Request Plan")).not.toBeInTheDocument();
    });

    // 3. Maintain happy path
    it("maintain: filling objective + selecting target + submitting calls createOperation", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("maintain"));
      // Type objective
      await user.type(screen.getByRole("textbox"), "Rotate API keys");
      // Switch scope from envoy (default) to environment, then select target
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      // Submit
      await user.click(screen.getByText("Plan Maintenance"));
      await waitFor(() => {
        expect(createOperation).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "maintain",
            intent: "Rotate API keys",
            environmentId: "env-1",
          }),
        );
      });
      expect(mockPushPanel).toHaveBeenCalledWith(
        expect.objectContaining({ type: "plan-review" }),
      );
    });

    // 4. Maintain empty objective — action bar not shown (canDeploy is false)
    it("maintain: action bar not shown with empty objective", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("maintain"));
      // Don't type anything — canDeploy requires intent.trim().length > 0
      expect(screen.queryByText("Plan Maintenance")).not.toBeInTheDocument();
    });

    // 5. Query happy path
    it("query: filling objective + selecting target + submitting calls createOperation with type query", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("query"));
      await user.type(screen.getByRole("textbox"), "Check disk usage");
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      await user.click(screen.getByText("Run Query"));
      await waitFor(() => {
        expect(createOperation).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "query",
            intent: "Check disk usage",
          }),
        );
      });
    });

    // 6. Investigate with allowWrite toggle
    it("investigate: toggling allowWrite sends it in the payload", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("investigate"));
      await user.type(screen.getByRole("textbox"), "Check 502 errors");
      const checkbox = screen.getByRole("checkbox");
      await user.click(checkbox);
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      await user.click(screen.getByText("Begin Investigation"));
      await waitFor(() => {
        expect(createOperation).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "investigate",
            intent: "Check 502 errors",
            allowWrite: true,
          }),
        );
      });
    });

    // 7. Trigger happy path
    it("trigger: filling condition + response + submitting sends trigger payload", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("trigger"));
      // Two textareas: condition and response
      const textareas = screen.getAllByRole("textbox");
      await user.type(textareas[0], "disk_usage > 85");
      await user.type(textareas[1], "Run cleanup");
      await user.click(screen.getByText("Create Trigger"));
      await waitFor(() => {
        expect(createOperation).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "trigger",
            condition: "disk_usage > 85",
            responseIntent: "Run cleanup",
          }),
        );
      });
    });

    // 8. Trigger empty condition — action bar not shown
    it("trigger: action bar not shown with empty condition", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("trigger"));
      // Only fill response, leave condition empty
      const textareas = screen.getAllByRole("textbox");
      await user.type(textareas[1], "Run cleanup");
      expect(screen.queryByText("Create Trigger")).not.toBeInTheDocument();
    });

    // 9. API failure shows error message
    it("API failure during submission shows error message", async () => {
      (createOperation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("web-app"));
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      await user.click(screen.getByText("Request Plan"));
      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
      expect(mockPushPanel).not.toHaveBeenCalled();
    });

    // 10. Submitting state disables button
    it("submit button shows loading state while request is in flight", async () => {
      (createOperation as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {})); // never resolves
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("web-app"));
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      await user.click(screen.getByText("Request Plan"));
      await waitFor(() => {
        expect(screen.getByText("Requesting…")).toBeInTheDocument();
      });
      expect(screen.getByText("Requesting…").closest("button")).toBeDisabled();
    });

    // 11. Force manual approval — query type defaults to auto-approve, so the toggle appears
    it("toggling require approval sends requireApproval in payload", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("query"));
      await user.type(screen.getByRole("textbox"), "Check disk usage");
      await user.click(screen.getByText("Environment"));
      await user.click(screen.getByText("production"));
      // Query defaults to auto-approve, so "Require approval" link should appear
      const requireLink = screen.getByText("Require approval");
      await user.click(requireLink);
      await user.click(screen.getByText("Run Query"));
      await waitFor(() => {
        expect(createOperation).toHaveBeenCalledWith(
          expect.objectContaining({ type: "query", requireApproval: true }),
        );
      });
    });
  });
});
