import { useCanvas } from "../context/CanvasContext.js";
import type { CanvasQueryResult } from "../api.js";
import CommandChannel from "./CommandChannel.js";
import OperationalOverview from "./canvas/OperationalOverview.js";
import PartitionDetailPanel from "./canvas/PartitionDetailPanel.js";
import EnvironmentDetailPanel from "./canvas/EnvironmentDetailPanel.js";
import DeploymentDetailPanel from "./canvas/DeploymentDetailPanel.js";
import DeploymentListPanel from "./canvas/DeploymentListPanel.js";
import DeploymentAuthoringPanel from "./canvas/DeploymentAuthoringPanel.js";
import OperationListPanel from "./canvas/OperationListPanel.js";
import PartitionListPanel from "./canvas/PartitionListPanel.js";
import OrderListPanel from "./canvas/OrderListPanel.js";
import OrderDetailPanel from "./canvas/OrderDetailPanel.js";
import DebriefPanel from "./canvas/DebriefPanel.js";
import SignalDetailPanel from "./canvas/SignalDetailPanel.js";
import SettingsPanel from "./canvas/SettingsPanel.js";
import ErrorBoundary from "./ErrorBoundary.js";

export default function AgentCanvas() {
  const { currentPanel, pushPanel } = useCanvas();

  function handleAgentResult(result: CanvasQueryResult) {
    switch (result.action) {
      case "deploy":
        pushPanel({
          type: "deployment-authoring",
          title: result.title ?? "New Deployment",
          params: { intent: "" },
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
            key={panel.id}
            partitionId={params.id}
            title={panel.title}
          />
        );

      case "environment-detail":
        return (
          <EnvironmentDetailPanel
            key={panel.id}
            environmentId={params.id}
            title={panel.title}
          />
        );

      case "deployment-detail":
        return (
          <DeploymentDetailPanel
            key={panel.id}
            deploymentId={params.id}
            title={panel.title}
          />
        );

      case "deployment-list":
        return (
          <DeploymentListPanel
            key={panel.id}
            title={panel.title}
            filterStatus={params.status}
            filterPartitionId={params.partitionId}
          />
        );

      case "deployment-authoring":
        return (
          <DeploymentAuthoringPanel
            key={panel.id}
            title={panel.title}
            initialIntent={params.intent}
            preselectedOrderId={params.orderId}
          />
        );

      case "operation-list":
        return <OperationListPanel key={panel.id} title={panel.title} />;

      case "partition-list":
        return <PartitionListPanel key={panel.id} title={panel.title} />;

      case "order-list":
        return (
          <OrderListPanel
            key={panel.id}
            title={panel.title}
            filterOperationId={params.operationId}
            filterPartitionId={params.partitionId}
          />
        );

      case "order-detail":
        return (
          <OrderDetailPanel
            key={panel.id}
            orderId={params.id}
            title={panel.title}
          />
        );

      case "debrief":
        return (
          <DebriefPanel
            key={panel.id}
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
            key={panel.id}
            signal={signal}
            title={panel.title}
          />
        );
      }

      case "settings":
        return <SettingsPanel key={panel.id} title={panel.title} />;

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
