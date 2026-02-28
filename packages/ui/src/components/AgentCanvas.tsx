import { useState, useRef } from "react";
import { useCanvas } from "../context/CanvasContext.js";
import { queryAgent } from "../api.js";
import type { CanvasQueryResult } from "../api.js";
import ModeToggle from "./ModeToggle.js";
import IntentBar from "./IntentBar.js";
import OperationalOverview from "./canvas/OperationalOverview.js";
import PartitionDetailPanel from "./canvas/PartitionDetailPanel.js";
import EnvironmentDetailPanel from "./canvas/EnvironmentDetailPanel.js";
import DeploymentDetailPanel from "./canvas/DeploymentDetailPanel.js";
import DeploymentListPanel from "./canvas/DeploymentListPanel.js";
import DeploymentAuthoringPanel from "./canvas/DeploymentAuthoringPanel.js";

export default function AgentCanvas() {
  const { currentPanel, pushPanel } = useCanvas();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef(crypto.randomUUID());

  async function handleIntent(intent: string) {
    setProcessing(true);
    setError(null);

    try {
      const result: CanvasQueryResult = await queryAgent(intent, conversationIdRef.current);

      switch (result.action) {
        case "deploy":
          pushPanel({
            type: "deployment-authoring",
            title: result.title ?? "New Deployment",
            params: { intent },
          });
          break;

        case "navigate":
        case "data":
          pushPanel({
            type: result.view,
            title: result.title ?? result.view,
            params: result.params ?? {},
          });
          break;
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setProcessing(false);
    }
  }

  function renderPanel() {
    const panel = currentPanel;

    switch (panel.type) {
      case "overview":
        return <OperationalOverview />;

      case "partition-detail":
        return (
          <PartitionDetailPanel
            key={panel.id}
            partitionId={panel.params.id}
            title={panel.title}
          />
        );

      case "environment-detail":
        return (
          <EnvironmentDetailPanel
            key={panel.id}
            environmentId={panel.params.id}
            title={panel.title}
          />
        );

      case "deployment-detail":
        return (
          <DeploymentDetailPanel
            key={panel.id}
            deploymentId={panel.params.id}
            title={panel.title}
          />
        );

      case "deployment-list":
        return (
          <DeploymentListPanel
            key={panel.id}
            title={panel.title}
            filterStatus={panel.params.status}
            filterPartitionId={panel.params.partitionId}
          />
        );

      case "deployment-authoring":
        return (
          <DeploymentAuthoringPanel
            key={panel.id}
            title={panel.title}
            initialIntent={panel.params.intent}
          />
        );

      default:
        return (
          <div className="canvas-empty">
            <p>Unknown view: {panel.type}</p>
          </div>
        );
    }
  }

  return (
    <div className="agent-canvas">
      {/* Top bar — minimal: logo + mode toggle */}
      <div className="canvas-topbar">
        <div className="canvas-topbar-left">
          <h1 className="canvas-logo">DeployStack</h1>
          <div className="canvas-mode-indicator">
            <span className="canvas-pulse-dot" />
            <span className="canvas-mode-label">AGENT</span>
          </div>
        </div>
        <div className="canvas-topbar-right">
          <ModeToggle />
        </div>
      </div>

      {/* Panel content area */}
      <div className="canvas-panel-stack">
        {error && (
          <div className="error-msg" style={{ margin: "16px 24px 0" }}>{error}</div>
        )}
        {renderPanel()}
      </div>

      {/* Intent bar — fixed at bottom, full width */}
      <div className="canvas-intent-bar">
        <IntentBar
          onSubmitIntent={handleIntent}
          onIntentResolved={() => {}}
          disabled={false}
          processing={processing}
        />
      </div>
    </div>
  );
}
