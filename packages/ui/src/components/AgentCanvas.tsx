import { useState } from "react";
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
import ArtifactCatalogPanel from "./canvas/ArtifactCatalogPanel.js";
import ArtifactDetailPanel from "./canvas/ArtifactDetailPanel.js";
import PlanReviewPanel from "./canvas/PlanReviewPanel.js";
import FleetDeploymentPanel from "./canvas/FleetDeploymentPanel.js";
import DeploymentGraphPanel from "./canvas/DeploymentGraphPanel.js";
import TopologyPanel from "./canvas/TopologyPanel.js";
import ErrorBoundary from "./ErrorBoundary.js";

export default function AgentCanvas() {
  const { currentPanel, pushPanel, minimizedDeployment, restoreDeployment } = useCanvas();

  // chatOpen drives the layout: false = strip bar at bottom, true = side panel
  const [chatOpen, setChatOpen] = useState(false);

  // For answer-type responses, right panel shows structured output instead of canvas panel
  const [answerContent, setAnswerContent] = useState<string | null>(null);

  function handleAgentResult(result: CanvasQueryResult) {
    setAnswerContent(null);
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

      case "deployment-authoring":
        return (
          <DeploymentAuthoringPanel
            key={`deployment-authoring:${params.artifactId ?? ""}`}
            title={panel.title}
            preselectedArtifactId={params.artifactId}
          />
        );

      case "partition-list":
        return <PartitionListPanel key="partition-list" title={panel.title} />;

      case "debrief":
        return (
          <DebriefPanel
            key={`debrief:${params.partitionId ?? ""}:${params.decisionType ?? ""}`}
            title={panel.title}
            filterPartitionId={params.partitionId}
            filterDecisionType={params.decisionType}
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

      default:
        return (
          <div className="v2-empty-state">
            <p>Unknown view: {panel.type}</p>
          </div>
        );
    }
  }

  const scope = currentPanel.type === "partition-detail" ? currentPanel.title : undefined;
  const hideChannel = currentPanel.type === "deployment-authoring";

  // SynthChannel is always rendered as a sibling of the canvas-main-content div
  // so React preserves its internal state (messages) when chatOpen switches.
  // CSS flex `order` controls visual placement: strip = below content, panel = left of content.
  return (
    <div className={chatOpen ? "canvas-split-layout" : "canvas-column-layout"}>
      {/* Canvas content — always DOM-first so React identity is stable */}
      <div className="canvas-main-content">
        <ErrorBoundary>
          {answerContent && chatOpen
            ? <StructuredOutputPanel content={answerContent} onDismiss={() => setAnswerContent(null)} />
            : renderPanel()
          }
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
                Deploying {minimizedDeployment.artifactName}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>In progress — click to view</div>
            </div>
            <div style={{ width: 48, height: 3, borderRadius: 2, background: "var(--surface-alt)", overflow: "hidden", marginLeft: 8 }}>
              <div style={{ height: "100%", borderRadius: 2, background: "var(--accent)", animation: "progressPulse 2s ease infinite" }} />
            </div>
          </div>
        )}
      </div>

      {/* SynthChannel — always DOM-second; CSS order puts it left in split, bottom in column */}
      {!hideChannel && (
        <SynthChannel
          scope={scope}
          mode={chatOpen ? "panel" : "strip"}
          onQuerySubmit={() => setChatOpen(true)}
          onAgentResult={handleAgentResult}
          onStructuredContent={(text) => setAnswerContent(text)}
          onDismiss={handleDismissChat}
        />
      )}
    </div>
  );
}
