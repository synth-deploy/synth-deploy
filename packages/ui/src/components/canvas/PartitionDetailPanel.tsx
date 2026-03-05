import { useState, useEffect } from "react";
import { getPartition, listDeployments, listEnvironments, getRecentDebrief } from "../../api.js";
import type { Partition, Deployment, Environment, DebriefEntry } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import SectionHeader from "../SectionHeader.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  partitionId: string;
  title: string;
}

export default function PartitionDetailPanel({ partitionId, title }: Props) {
  const { pushPanel } = useCanvas();

  const [partition, setPartition] = useState<Partition | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [debriefEntries, setDebriefEntries] = useState<DebriefEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "variables" | "history">("overview");

  useEffect(() => {
    Promise.all([
      getPartition(partitionId),
      listDeployments({ partitionId }),
      listEnvironments(),
      getRecentDebrief({ partitionId, limit: 10 }).catch(() => []),
    ]).then(([p, d, e, db]) => {
      setPartition(p);
      setDeployments(d);
      setEnvironments(e);
      setDebriefEntries(db);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [partitionId]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!partition) return <CanvasPanelHost title={title}><div className="error-msg">Partition not found</div></CanvasPanelHost>;

  const vars = Object.entries(partition.variables);
  const sortedDeploys = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const succeededCount = deployments.filter((d) => d.status === "succeeded").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeededCount / deployments.length) * 100)}%`
    : "\u2014";

  return (
    <CanvasPanelHost title={title}>
      <div className="v2-detail-view">
        {/* Partition header with barrier styling */}
        <div className="v2-partition-detail-header">
          <div className="v2-partition-barrier v2-barrier-top" />
          <div className="v2-partition-barrier v2-barrier-bottom" />
          <div className="v2-partition-barrier v2-barrier-left" />
          <div className="v2-partition-barrier v2-barrier-right" />

          <div className="v2-partition-detail-content">
            <div className="v2-partition-detail-avatar">
              <span>{partition.name[0]}</span>
            </div>
            <div className="v2-partition-detail-info">
              <div className="v2-partition-detail-title-row">
                <span className="v2-partition-detail-name">{partition.name}</span>
                <div className="v2-status-active-badge">ACTIVE</div>
              </div>
              <div className="v2-partition-detail-envs">
                {environments.map((e) => (
                  <button
                    key={e.id}
                    className="v2-env-tag"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      pushPanel({
                        type: "environment-detail",
                        title: e.name,
                        params: { id: e.id },
                      });
                    }}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="v2-partition-detail-stats">
              <div className="v2-stat-col">
                <span className="v2-stat-value">{vars.length}</span>
                <span className="v2-stat-label">Variables</span>
              </div>
              <div className="v2-stat-col">
                <span className="v2-stat-value">{deployments.length}</span>
                <span className="v2-stat-label">Deployments</span>
              </div>
              <div className="v2-stat-col">
                <span className="v2-stat-value">{successRate}</span>
                <span className="v2-stat-label">Success Rate</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="v2-tab-bar">
          {(["overview", "variables", "history"] as const).map((tab) => (
            <button
              key={tab}
              className={`v2-tab ${activeTab === tab ? "v2-tab-active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <div className="v2-detail-columns">
            <div className="v2-detail-main">
              {/* Recent deployments */}
              <SectionHeader color="#34d399" shape="circle" label="Recent Deployments" subtitle={`for ${partition.name}`} />
              <div className="v2-scoped-list">
                {sortedDeploys.slice(0, 10).map((d) => {
                  const envName = environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId;
                  return (
                    <div
                      key={d.id}
                      className="v2-deploy-row"
                      onClick={() => pushPanel({
                        type: "deployment-detail",
                        title: `Deployment ${d.version}`,
                        params: { id: d.id },
                      })}
                    >
                      <div className={`v2-deploy-dot v2-deploy-${d.status}`} />
                      <div className="v2-deploy-info">
                        <span className="v2-deploy-version">{d.version}</span>
                        <span className="v2-deploy-env">{envName}</span>
                      </div>
                      <span className="v2-deploy-time">
                        {new Date(d.createdAt).toLocaleString()}
                      </span>
                      <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>
                        {d.status}
                      </div>
                    </div>
                  );
                })}
                {sortedDeploys.length === 0 && (
                  <div className="v2-empty-hint">No deployments for this partition</div>
                )}
              </div>
            </div>

            {/* Right: Debriefs */}
            <div className="v2-detail-sidebar">
              <SectionHeader color="#e879f9" shape="diamond" label="Recent Debriefs" />
              <div className="v2-scoped-list">
                {debriefEntries.length > 0 ? debriefEntries.slice(0, 5).map((entry) => (
                  <div key={entry.id} className="v2-debrief-row v2-debrief-compact">
                    <div className="v2-debrief-status-bar" style={{ background: "#63e1be" }} />
                    <div className="v2-debrief-content">
                      <div className="v2-debrief-body">
                        <div className="v2-debrief-header">
                          <span className="v2-debrief-time">
                            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                          <span className="v2-debrief-from">
                            {entry.agent === "envoy" ? "Envoy" : "Command"}
                          </span>
                        </div>
                        <div className="v2-debrief-summary">{entry.decision}</div>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="v2-empty-hint">No recent Debriefs for this Partition</div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "variables" && (
          <div className="v2-variables-view">
            <div className="v2-variables-header">
              <span className="v2-variables-count">{vars.length} VARIABLES</span>
              <button className="v2-create-btn v2-create-btn-partition">+ Add Variable</button>
            </div>
            <div className="v2-variables-table">
              <div className="v2-variables-table-header">
                <div style={{ flex: 1 }}>Key</div>
                <div style={{ flex: 2 }}>Value</div>
              </div>
              {vars.map(([k, v]) => (
                <div key={k} className="v2-variables-table-row">
                  <div className="v2-var-key" style={{ flex: 1 }}>{k}</div>
                  <div className="v2-var-value" style={{ flex: 2 }}>{v}</div>
                </div>
              ))}
              {vars.length === 0 && (
                <div className="v2-empty-hint" style={{ padding: 16 }}>No variables configured</div>
              )}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="v2-history-view">
            <span className="v2-history-label">DEPLOYMENT HISTORY</span>
            <div className="v2-scoped-list">
              {sortedDeploys.map((d) => {
                const envName = environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId;
                const isFailed = d.status === "failed";
                return (
                  <div
                    key={d.id}
                    className={`v2-history-row ${isFailed ? "v2-history-failed" : ""}`}
                    onClick={() => pushPanel({
                      type: "deployment-detail",
                      title: `Deployment ${d.version}`,
                      params: { id: d.id },
                    })}
                  >
                    <div className={`v2-history-dot ${isFailed ? "v2-dot-failed" : "v2-dot-success"}`} />
                    <div className="v2-deploy-info">
                      <span className="v2-deploy-version">{d.version}</span>
                      <span className="v2-deploy-env">{envName}</span>
                    </div>
                    <span className="v2-deploy-time">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                    <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>
                      {d.status}
                    </div>
                  </div>
                );
              })}
              {sortedDeploys.length === 0 && (
                <div className="v2-empty-hint">No deployment history</div>
              )}
            </div>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
