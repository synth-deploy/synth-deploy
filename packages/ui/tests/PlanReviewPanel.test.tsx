/**
 * PlanReviewPanel journey tests — verifies the approval, rejection,
 * and refinement flows that users go through after creating an operation.
 */
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CanvasProvider } from "../src/context/CanvasContext";

// ---------------------------------------------------------------------------
// Mocks — must come before component import
// ---------------------------------------------------------------------------

const mockReplacePanel = vi.fn();
const mockPopPanel = vi.fn();
const mockPushPanel = vi.fn();
const mockMinimizeDeployment = vi.fn();

vi.mock("../src/context/CanvasContext", async () => {
  const actual = await vi.importActual("../src/context/CanvasContext");
  return {
    ...actual,
    useCanvas: () => ({
      replacePanel: mockReplacePanel,
      popPanel: mockPopPanel,
      pushPanel: mockPushPanel,
      minimizeDeployment: mockMinimizeDeployment,
      panels: [],
      currentPanel: { id: "1", type: "plan-review", title: "Review Plan", params: { id: "op-123" } },
      depth: 2,
      minimizedDeployment: null,
      restoreDeployment: vi.fn(),
      clearMinimizedDeployment: vi.fn(),
      resetToOverview: vi.fn(),
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

// Stub SynthMark to avoid HTMLCanvasElement.getContext errors in jsdom
vi.mock("../src/components/SynthMark", () => ({
  default: ({ size }: { size?: number }) => <span data-testid="synth-mark" data-size={size} />,
}));

// Stub ConfidenceIndicator (no canvas, but simplifies DOM)
vi.mock("../src/components/ConfidenceIndicator", () => ({
  default: ({ value }: { value: number }) => <span data-testid="confidence" data-value={value} />,
}));

// vi.mock factories are hoisted — they cannot reference module-scoped variables.
// Return bare vi.fn() stubs; actual return values are configured in beforeEach.
vi.mock("../src/hooks/useQuery", () => ({
  useQuery: vi.fn(),
  invalidateExact: vi.fn(),
  setQueryData: vi.fn(),
}));

vi.mock("../src/api", () => ({
  getDeployment: vi.fn(),
  getDeploymentEnrichment: vi.fn(),
  approveDeployment: vi.fn(),
  rejectDeployment: vi.fn(),
  shelveDeployment: vi.fn(),
  modifyDeploymentPlan: vi.fn(),
  replanDeployment: vi.fn(),
  listEnvironments: vi.fn(),
  listArtifacts: vi.fn(),
  listPartitions: vi.fn(),
  createOperation: vi.fn(),
}));

import PlanReviewPanel from "../src/components/canvas/PlanReviewPanel";
import {
  approveDeployment,
  rejectDeployment,
  shelveDeployment,
  replanDeployment,
  getDeployment,
  getDeploymentEnrichment,
} from "../src/api";
import { useQuery } from "../src/hooks/useQuery";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockPlan = {
  scriptedPlan: {
    platform: "bash" as const,
    reasoning: "Standard rolling deployment with pre-pull for zero-downtime.",
    steps: [
      {
        description: "Pull image web-app:1.2.0",
        script: "docker pull web-app:1.2.0",
        dryRunScript: "docker image inspect web-app:1.2.0 || true",
        rollbackScript: null,
        reversible: true,
      },
      {
        description: "Stop current container",
        script: "docker stop web-app",
        dryRunScript: "docker ps -q -f name=web-app",
        rollbackScript: "docker start web-app",
        reversible: true,
      },
      {
        description: "Start new container",
        script: "docker run -d --name web-app web-app:1.2.0",
        dryRunScript: null,
        rollbackScript: "docker stop web-app-new || true",
        reversible: true,
      },
    ],
  },
  reasoning: "Standard rolling deployment with pre-pull for zero-downtime.",
};

const mockDeployment = {
  id: "op-123",
  artifactId: "art-1",
  environmentId: "env-1",
  version: "1.2.0",
  status: "awaiting_approval" as const,
  variables: {},
  plan: mockPlan,
  input: { type: "deploy" as const },
  debriefEntryIds: [],
  createdAt: new Date().toISOString(),
  completedAt: null,
  failureReason: null,
};

const mockDeploymentResult = {
  deployment: mockDeployment,
  debrief: [],
};

const mockEnrichmentResult = {
  enrichment: {
    recentOperationsToEnv: 2,
    previouslyRolledBack: false,
    conflictingOperations: [],
  },
  recommendation: {
    verdict: "proceed" as const,
    summary: "No issues detected",
    factors: [],
  },
};

const mockArtifacts = [
  { id: "art-1", name: "web-app", type: "docker-image", analysis: { summary: "A web app", dependencies: [], configurationExpectations: {}, confidence: 0.9 }, annotations: [], learningHistory: [], createdAt: new Date(), updatedAt: new Date() },
];
const mockEnvironments = [
  { id: "env-1", name: "production", variables: { APP_ENV: "production" }, createdAt: new Date(), updatedAt: new Date() },
];
const mockPartitions = [
  { id: "part-1", name: "AcmeCorp", variables: { DB_HOST: "acme-db" }, createdAt: new Date(), updatedAt: new Date() },
];

// ---------------------------------------------------------------------------
// Stable useQuery return references — must be the same object across renders
// to avoid infinite re-render loops caused by useEffect dependencies.
// ---------------------------------------------------------------------------

const stableQueryResults: Record<string, { data: unknown; loading: boolean }> = {
  deployment: { data: mockDeploymentResult, loading: false },
  enrichment: { data: mockEnrichmentResult, loading: false },
  environments: { data: mockEnvironments, loading: false },
  artifacts: { data: mockArtifacts, loading: false },
  partitions: { data: mockPartitions, loading: false },
  empty: { data: null, loading: false },
  loading: { data: null, loading: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure useQuery to return the standard "awaiting_approval" data set. */
function setupDefaultUseQuery() {
  (useQuery as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
    if (key.startsWith("deployment:")) return stableQueryResults.deployment;
    if (key.startsWith("deploymentEnrichment:")) return stableQueryResults.enrichment;
    if (key === "list:environments") return stableQueryResults.environments;
    if (key === "list:artifacts") return stableQueryResults.artifacts;
    if (key === "list:partitions") return stableQueryResults.partitions;
    return stableQueryResults.empty;
  });
}

/** Configure ../src/api mocks with sensible default resolved values. */
function setupDefaultApiMocks() {
  (getDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({ deployment: { ...mockDeployment }, debrief: [] });
  (getDeploymentEnrichment as ReturnType<typeof vi.fn>).mockResolvedValue(mockEnrichmentResult);
  (approveDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
    deployment: { id: "op-123", status: "approved" },
  });
  (rejectDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
    deployment: { id: "op-123", status: "rejected" },
  });
  (shelveDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
    deployment: { id: "op-123", status: "shelved" },
  });
  (replanDeployment as ReturnType<typeof vi.fn>).mockResolvedValue({
    deployment: { ...mockDeployment, plan: { ...mockPlan, reasoning: "Revised plan." } },
  });
}

function renderPanel(deploymentId = "op-123") {
  return render(
    <CanvasProvider>
      <PlanReviewPanel deploymentId={deploymentId} title="Review Plan" />
    </CanvasProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlanReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultUseQuery();
    setupDefaultApiMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("plan display", () => {
    it("renders plan step descriptions", () => {
      renderPanel();
      expect(screen.getByText("Pull image web-app:1.2.0")).toBeInTheDocument();
      expect(screen.getByText("Stop current container")).toBeInTheDocument();
      expect(screen.getByText("Start new container")).toBeInTheDocument();
    });

    it("shows Greenlight, Refine, and Shelve buttons when awaiting approval", () => {
      renderPanel();
      expect(screen.getByText(/Greenlight/)).toBeInTheDocument();
      expect(screen.getByText("Refine")).toBeInTheDocument();
      expect(screen.getByText("Shelve")).toBeInTheDocument();
    });

    it("displays artifact name in the heading and environment in sub-heading", () => {
      renderPanel();
      // The h2 contains "web-app" (artifact name) and a span with "1.2.0"
      const heading = screen.getByRole("heading", { level: 2 });
      expect(heading).toHaveTextContent("web-app");
      expect(heading).toHaveTextContent("1.2.0");
      // Environment name appears in the "-> envName" sub-heading
      expect(screen.getByText(/→ production/)).toBeInTheDocument();
    });
  });

  describe("greenlight journey", () => {
    it("clicking Greenlight calls approveDeployment and navigates to deployment-detail", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText(/Greenlight/));
      await waitFor(() => {
        expect(approveDeployment).toHaveBeenCalledWith("op-123", { approvedBy: "user" });
      });
      expect(mockReplacePanel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deployment-detail",
          params: expect.objectContaining({ id: "op-123" }),
        }),
      );
    });

    it("Greenlight API failure shows error message without navigating", async () => {
      (approveDeployment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Conflict"));
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText(/Greenlight/));
      await waitFor(() => {
        expect(screen.getByText("Conflict")).toBeInTheDocument();
      });
      expect(mockReplacePanel).not.toHaveBeenCalled();
    });
  });

  describe("shelve journey", () => {
    it("clicking Shelve -> confirming calls shelveDeployment and navigates", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Shelve"));
      // Textarea for optional reason should appear
      const textarea = screen.getByPlaceholderText("Why are you shelving this? (e.g. maintenance window, not the right time)");
      expect(textarea).toBeInTheDocument();
      await user.type(textarea, "Not the right time");
      await user.click(screen.getByText("Shelve Plan"));
      await waitFor(() => {
        expect(shelveDeployment).toHaveBeenCalledWith("op-123", { reason: "Not the right time" });
      });
      expect(mockReplacePanel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deployment-detail",
          params: expect.objectContaining({ id: "op-123" }),
        }),
      );
    });

    it("shelving with no reason still calls shelveDeployment (reason is optional)", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Shelve"));
      await user.click(screen.getByText("Shelve Plan"));
      await waitFor(() => {
        expect(shelveDeployment).toHaveBeenCalledWith("op-123", { reason: undefined });
      });
    });

    it("cancelling from shelve mode returns to review without calling API", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Shelve"));
      expect(screen.getByText("Shelve Plan")).toBeInTheDocument();
      await user.click(screen.getByText("Cancel"));
      expect(screen.getByText(/Greenlight/)).toBeInTheDocument();
      expect(shelveDeployment).not.toHaveBeenCalled();
    });

    it("shelve API failure shows error message without navigating", async () => {
      (shelveDeployment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Server error"));
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Shelve"));
      await user.type(screen.getByPlaceholderText("Why are you shelving this? (e.g. maintenance window, not the right time)"), "Bad timing");
      await user.click(screen.getByText("Shelve Plan"));
      await waitFor(() => {
        expect(screen.getByText("Server error")).toBeInTheDocument();
      });
      expect(mockReplacePanel).not.toHaveBeenCalled();
    });
  });

  describe("refine journey", () => {
    it("clicking Refine -> entering feedback -> submitting calls replanDeployment", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Refine"));
      // Should show the refine heading
      expect(screen.getByText("What should Synth reconsider?")).toBeInTheDocument();
      const textarea = screen.getByRole("textbox");
      await user.type(textarea, "Add health check after deploy");
      await user.click(screen.getByText("Revise Plan"));
      await waitFor(() => {
        expect(replanDeployment).toHaveBeenCalledWith("op-123", "Add health check after deploy");
      });
    });

    it("refine with empty feedback shows validation error", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Refine"));
      // Don't type anything
      await user.click(screen.getByText("Revise Plan"));
      await waitFor(() => {
        expect(screen.getByText("Please describe what Synth should reconsider")).toBeInTheDocument();
      });
      expect(replanDeployment).not.toHaveBeenCalled();
    });

    it("cancelling from refine mode returns to review mode", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByText("Refine"));
      expect(screen.getByText("Revise Plan")).toBeInTheDocument();
      await user.click(screen.getByText("Cancel"));
      // Should see Refine button again (review mode)
      expect(screen.getByText("Refine")).toBeInTheDocument();
      expect(replanDeployment).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("shows error when deployment is not found", () => {
      const nullDeployment = { data: null, loading: false };
      (useQuery as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key.startsWith("deployment:")) return nullDeployment;
        if (key.startsWith("deploymentEnrichment:")) return nullDeployment;
        if (key === "list:environments") return stableQueryResults.environments;
        if (key === "list:artifacts") return stableQueryResults.artifacts;
        if (key === "list:partitions") return stableQueryResults.partitions;
        return nullDeployment;
      });
      renderPanel();
      expect(screen.getByText("Deployment not found")).toBeInTheDocument();
    });

    it("shows status message when deployment is not awaiting approval", () => {
      const runningDeployment = { ...mockDeployment, status: "running" as const };
      const runningResult = { data: { deployment: runningDeployment, debrief: [] }, loading: false };
      (useQuery as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key.startsWith("deployment:")) return runningResult;
        if (key.startsWith("deploymentEnrichment:")) return stableQueryResults.enrichment;
        if (key === "list:environments") return stableQueryResults.environments;
        if (key === "list:artifacts") return stableQueryResults.artifacts;
        if (key === "list:partitions") return stableQueryResults.partitions;
        return stableQueryResults.empty;
      });
      renderPanel();
      expect(screen.getByText(/not awaiting approval/)).toBeInTheDocument();
    });

    it("shows loading state while queries are pending", () => {
      (useQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return stableQueryResults.loading;
      });
      renderPanel();
      expect(screen.getByText(/Loading plan/)).toBeInTheDocument();
    });
  });
});
