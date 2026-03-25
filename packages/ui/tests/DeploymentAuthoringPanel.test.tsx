/**
 * Operation authoring panel tests — verifies the form logic and field visibility
 * for all 6 operation types (deploy, maintain, query, investigate, trigger, composite).
 */
import { render, screen, within } from "@testing-library/react";
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
}));

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

    it("shows Objective as optional for deploy", () => {
      renderPanel();
      expect(screen.getByText("Objective (optional)")).toBeInTheDocument();
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
});
