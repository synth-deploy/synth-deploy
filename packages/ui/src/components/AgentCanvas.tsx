import { useCanvas } from "../context/CanvasContext.js";
import type { CanvasQueryResult } from "../api.js";
import CommandChannel from "./CommandChannel.js";
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
import ErrorBoundary from "./ErrorBoundary.js";

export default function AgentCanvas() {
  const { currentPanel, pushPanel } = useCanvas();

  function handleAgentResult(result: CanvasQueryResult) {
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

  // Determine scope for CommandChannel based on current panel
  const scope = currentPanel.type === "partition-detail"
    ? currentPanel.title
    : undefined;

  return (
    <div className="v2-canvas">
      {/* Panel content area */}
      <div className="v2-canvas-content">
        <ErrorBoundary>
          {renderPanel()}
        </ErrorBoundary>
      </div>

      {/* CommandChannel — fixed at bottom */}
      <CommandChannel
        scope={scope}
        onAgentResult={handleAgentResult}
      />
    </div>
  );
}
