import { useState, useRef, useEffect, useCallback } from "react";
import { useCanvas } from "../context/CanvasContext.js";
import type { CanvasQueryResult } from "../api.js";
import SynthChannel from "./SynthChannel.js";
import SynthMark from "./SynthMark.js";
import StructuredOutputPanel from "./StructuredOutputPanel.js";
import OperationalOverview from "./canvas/OperationalOverview.js";
import PartitionDetailPanel from "./canvas/PartitionDetailPanel.js";
import EnvironmentDetailPanel from "./canvas/EnvironmentDetailPanel.js";
import DeploymentDetailPanel from "./canvas/DeploymentDetailPanel.js";
import DeploymentListPanel from "./canvas/DeploymentListPanel.js";
import DeploymentAuthoringPanel from "./canvas/DeploymentAuthoringPanel.js";
import PartitionListPanel from "./canvas/PartitionListPanel.js";
import DebriefPanel from "./canvas/DebriefPanel.js";
import SignalDetailPanel from "./canvas/SignalDetailPanel.js";
import EnvoyRegistryPanel from "./canvas/EnvoyRegistryPanel.js";
import EnvoyDetailPanel from "./canvas/EnvoyDetailPanel.js";
import SettingsPanel from "./canvas/SettingsPanel.js";
import UserSettingsPanel from "./canvas/UserSettingsPanel.js";
import ArtifactCatalogPanel from "./canvas/ArtifactCatalogPanel.js";
import ArtifactDetailPanel from "./canvas/ArtifactDetailPanel.js";
import PlanReviewPanel from "./canvas/PlanReviewPanel.js";
import FleetDeploymentPanel from "./canvas/FleetDeploymentPanel.js";
import DeploymentGraphPanel from "./canvas/DeploymentGraphPanel.js";
import TopologyPanel from "./canvas/TopologyPanel.js";
import ErrorBoundary from "./ErrorBoundary.js";

const MIN_CHAT_WIDTH = 220;
const MAX_CHAT_WIDTH = 640;
const DEFAULT_CHAT_WIDTH = 340;

const TAB_ORDER = ["operation-authoring", "artifact-catalog", "topology", "debrief"] as const;
type TabType = typeof TAB_ORDER[number];

export default function AgentCanvas() {
  const { currentPanel, pushPanel, minimizedDeployment, restoreDeployment } = useCanvas();

  // Compute directional slide for tab transitions during render (no effect delay)
  const prevPanelTypeRef = useRef<string>(currentPanel.type);
  let slideDir: "left" | "right" | null = null;
  if (prevPanelTypeRef.current !== currentPanel.type) {
    const prevIdx = TAB_ORDER.indexOf(prevPanelTypeRef.current as TabType);
    const nextIdx = TAB_ORDER.indexOf(currentPanel.type as TabType);
    if (prevIdx !== -1 && nextIdx !== -1) {
      slideDir = nextIdx > prevIdx ? "right" : "left";
    }
    prevPanelTypeRef.current = currentPanel.type;
  }

  // chatOpen drives the layout: false = strip bar at bottom, true = side panel
  const [chatOpen, setChatOpen] = useState(false);

  // For answer-type responses, right panel shows structured output instead of canvas panel
  const [answerContent, setAnswerContent] = useState<string | null>(null);
  const [answerTitle, setAnswerTitle] = useState<string | undefined>(undefined);

  // Resizable split
  const [splitWidth, setSplitWidth] = useState(DEFAULT_CHAT_WIDTH);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = splitWidth;
    e.preventDefault();
  }, [splitWidth]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      setSplitWidth(Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, dragStartWidth.current + delta)));
    }
    function onMouseUp() { isDragging.current = false; }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function handleAgentResult(result: CanvasQueryResult) {
    setAnswerContent(null);
    setAnswerTitle(undefined);
    switch (result.action) {
      case "navigate":
      case "data":
        pushPanel({
          type: result.view,
          title: result.title ?? result.view,
          params: result.params ?? {},
        });
        break;
    }
  }

  function handleDismissChat() {
    setChatOpen(false);
    setAnswerContent(null);
    setAnswerTitle(undefined);
  }

  function renderPanel() {
    const panel = currentPanel;
    const params = panel.params ?? {};

    switch (panel.type) {
      case "overview":
        return <OperationalOverview />;

      case "partition-detail":
        return (
          <PartitionDetailPanel
            key={`partition-detail:${params.id}`}
            partitionId={params.id}
            title={panel.title}
          />
        );

      case "environment-detail":
        return (
          <EnvironmentDetailPanel
            key={`environment-detail:${params.id}`}
            environmentId={params.id}
            title={panel.title}
          />
        );

      case "deployment-detail":
        return (
          <DeploymentDetailPanel
            key={`deployment-detail:${params.id}`}
            deploymentId={params.id}
            title={panel.title}
          />
        );

      case "deployment-list":
        return (
          <DeploymentListPanel
            key={`deployment-list:${params.status ?? ""}:${params.partitionId ?? ""}`}
            title={panel.title}
            filterStatus={params.status}
            filterPartitionId={params.partitionId}
          />
        );

      case "operation-authoring":
        return (
          <DeploymentAuthoringPanel
            key={`operation-authoring:${params.artifactId ?? ""}:${params.environmentId ?? ""}:${params.partitionId ?? ""}`}
            title={panel.title}
            preselectedArtifactId={params.artifactId}
            preselectedEnvironmentId={params.environmentId}
            preselectedPartitionId={params.partitionId}
          />
        );

      case "partition-list":
        return <PartitionListPanel key="partition-list" title={panel.title} />;

      case "debrief":
        return (
          <DebriefPanel
            key={`debrief:${params.partitionId ?? ""}:${params.decisionType ?? ""}:${params.deploymentId ?? ""}`}
            title={panel.title}
            filterPartitionId={params.partitionId}
            filterDecisionType={params.decisionType}
            initialDeploymentId={params.deploymentId}
          />
        );

      case "signal-detail": {
        const signal = params.signal ? JSON.parse(params.signal) : null;
        if (!signal) {
          return (
            <div className="v2-empty-state">
              <p>No signal data available.</p>
            </div>
          );
        }
        return (
          <SignalDetailPanel
            key={`signal-detail:${panel.id}`}
            signal={signal}
            title={panel.title}
          />
        );
      }

      case "envoy-registry":
        return <EnvoyRegistryPanel key="envoy-registry" title={panel.title} />;

      case "envoy-detail":
        return (
          <EnvoyDetailPanel
            key={`envoy-detail:${params.id}`}
            envoyId={params.id}
            title={panel.title}
          />
        );

      case "artifact-catalog":
        return <ArtifactCatalogPanel key="artifact-catalog" title={panel.title} />;

      case "artifact-detail":
        return (
          <ArtifactDetailPanel
            key={`artifact-detail:${params.artifactId}`}
            artifactId={params.artifactId}
            title={panel.title}
          />
        );

      case "plan-review":
        return (
          <PlanReviewPanel
            key={`plan-review:${params.id}`}
            deploymentId={params.id}
            title={panel.title}
          />
        );

      case "fleet-deployment":
        return (
          <FleetDeploymentPanel
            key={`fleet-deployment:${params.id}`}
            fleetDeploymentId={params.id}
            title={panel.title}
          />
        );

      case "deployment-graph":
        return (
          <DeploymentGraphPanel
            key={`deployment-graph:${params.id}`}
            graphId={params.id}
            title={panel.title}
          />
        );

      case "topology":
        return <TopologyPanel key="topology" title={panel.title} />;

      case "settings":
        return <SettingsPanel key="settings" title={panel.title} />;

      case "user-settings":
        return <UserSettingsPanel key="user-settings" title={panel.title} />;

      default:
        return (
          <div className="v2-empty-state">
            <p>Unknown view: {panel.type}</p>
          </div>
        );
    }
  }

  const scope = currentPanel.type === "partition-detail" ? currentPanel.title : undefined;
  const hideChannel = currentPanel.type === "operation-authoring";

  // SynthChannel is always rendered as a sibling of the canvas-main-content div
  // so React preserves its internal state (messages) when chatOpen switches.
  // In split mode: channel (order:1) | drag-handle (order:2) | content (order:3)
  // In column mode: content (default) above, strip bar below
  return (
    <div className={chatOpen ? "canvas-split-layout" : "canvas-column-layout"}>
      {/* Canvas content — always DOM-first so React identity is stable */}
      <div className="canvas-main-content">
        <ErrorBoundary key={currentPanel.id}>
          <div
            key={currentPanel.id}
            className={slideDir ? `panel-enter-from-${slideDir}` : undefined}
            style={{ height: "100%", width: "100%" }}
          >
            {answerContent && chatOpen
              ? <StructuredOutputPanel
                  content={answerContent}
                  title={answerTitle}
                  onDismiss={() => { setAnswerContent(null); setAnswerTitle(undefined); }}
                  onNavigate={(view, params) => {
                    setAnswerContent(null);
                    setAnswerTitle(undefined);
                    pushPanel({ type: view, title: params.id ?? view, params });
                  }}
                />
              : renderPanel()
            }
          </div>
        </ErrorBoundary>
        {minimizedDeployment && (
          <div
            onClick={restoreDeployment}
            style={{
              position: "fixed",
              bottom: 20,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 200,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 20px",
              borderRadius: 10,
              background: "var(--surface)",
              border: "1px solid var(--accent-border)",
              boxShadow: "0 24px 80px color-mix(in srgb, var(--text) 15%, transparent)",
              cursor: "pointer",
              animation: "fadeUp 0.25s ease",
            }}
          >
            <SynthMark size={16} active={true} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {minimizedDeployment.panelType === "plan-review"
                  ? `Planning ${minimizedDeployment.artifactName}`
                  : `Deploying ${minimizedDeployment.artifactName}`}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {minimizedDeployment.panelType === "plan-review"
                  ? "Reasoning in progress — click to review"
                  : "In progress — click to view"}
              </div>
            </div>
            <div style={{ width: 48, height: 3, borderRadius: 2, background: "var(--surface-alt)", overflow: "hidden", marginLeft: 8 }}>
              <div style={{ height: "100%", borderRadius: 2, background: "var(--accent)", animation: "progressPulse 2s ease infinite" }} />
            </div>
          </div>
        )}
      </div>

      {/* Drag handle — only visible in split mode, between channel and content */}
      {chatOpen && !hideChannel && (
        <div className="canvas-split-handle" onMouseDown={handleDragStart} />
      )}

      {/* SynthChannel — always DOM-last; CSS order puts it left in split, bottom in column */}
      {!hideChannel && (
        <SynthChannel
          scope={scope}
          mode={chatOpen ? "panel" : "strip"}
          onQuerySubmit={() => setChatOpen(true)}
          onAgentResult={handleAgentResult}
          onStructuredContent={(text, title) => { setAnswerContent(text); setAnswerTitle(title); }}
          onDismiss={handleDismissChat}
          style={chatOpen ? { width: splitWidth, flexShrink: 0 } : undefined}
        />
      )}
    </div>
  );
}
