import { useState } from "react";
import { listTemplates, deleteTemplate, applyTemplate, listEnvironments } from "../../api.js";
import type { OperationTemplate, Environment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SectionHeader from "../SectionHeader.js";
import { useQuery, invalidate } from "../../hooks/useQuery.js";

interface Props {
  title: string;
}

const OP_TYPE_COLORS: Record<string, string> = {
  deploy: "var(--accent)",
  maintain: "var(--status-warning)",
  query: "var(--status-succeeded)",
  investigate: "var(--status-failed)",
  execute: "var(--text-muted)",
  composite: "var(--accent)",
  trigger: "var(--status-warning)",
};

export default function OperationTemplatePanel({ title }: Props) {
  const { pushPanel } = useCanvas();
  const { data: templates, loading } = useQuery<OperationTemplate[]>(
    "list:templates",
    listTemplates,
    { refetchInterval: 10000 },
  );
  const { data: envs } = useQuery<Environment[]>(
    "list:environments",
    () => listEnvironments().catch(() => [] as Environment[]),
  );

  const [selected, setSelected] = useState<OperationTemplate | null>(null);
  const [applyEnvId, setApplyEnvId] = useState("");
  const [applyParams, setApplyParams] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function selectTemplate(t: OperationTemplate) {
    setSelected(t);
    setApplyError(null);
    // Pre-fill defaults
    const defaults: Record<string, string> = {};
    for (const p of t.parameters) {
      if (p.defaultValue !== undefined) defaults[p.name] = p.defaultValue;
    }
    setApplyParams(defaults);
  }

  async function handleApply() {
    if (!selected) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyTemplate(selected.id, {
        environmentId: applyEnvId || undefined,
        parameters: applyParams,
      });
      pushPanel({ type: "deployment-detail", title: "Operation", params: { id: result.operationId } });
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Failed to apply template");
    } finally {
      setApplying(false);
    }
  }

  async function handleDelete(t: OperationTemplate) {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    setDeleting(true);
    try {
      await deleteTemplate(t.id);
      if (selected?.id === t.id) setSelected(null);
      invalidate("list:templates");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <CanvasPanelHost title={title} noBreadcrumb>
      <div style={{ padding: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h1 className="v6-page-title">Operation Templates</h1>
            <p className="v6-page-subtitle">
              Saved operation patterns for reuse. Apply with parameter values to spin up operations instantly.
              <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                {(templates ?? []).length} template{(templates ?? []).length !== 1 ? "s" : ""}
              </span>
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, height: "calc(100% - 100px)" }}>
        {/* Template list */}
        <div style={{ flex: "0 0 320px", borderRight: "1px solid var(--border)", overflowY: "auto", padding: "0 16px 16px" }}>
          {loading && <div className="loading" style={{ padding: 16 }}>Loading...</div>}
          {!loading && (templates ?? []).length === 0 && (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No templates saved yet.
              <br />
              <span style={{ fontSize: 12, marginTop: 4, display: "block" }}>
                Create one from the Operations tab after authoring.
              </span>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(templates ?? []).map((t) => {
              const isSelected = selected?.id === t.id;
              return (
                <div
                  key={t.id}
                  onClick={() => selectTemplate(t)}
                  style={{
                    padding: "12px 14px",
                    borderRadius: 8,
                    border: `1px solid ${isSelected ? "var(--accent-border)" : "var(--border)"}`,
                    background: isSelected ? "var(--accent-dim)" : "var(--surface)",
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: OP_TYPE_COLORS[t.input.type] ?? "var(--text-muted)",
                      border: `1px solid ${OP_TYPE_COLORS[t.input.type] ?? "var(--border)"}`,
                      borderRadius: 3,
                      padding: "1px 5px",
                    }}>
                      {t.input.type}
                    </span>
                    {t.parameters.length > 0 && (
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {t.parameters.length} param{t.parameters.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{t.name}</div>
                  {t.description && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>
                      {t.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Apply panel */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 24px" }}>
          {!selected ? (
            <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Select a template to apply it.
            </div>
          ) : (
            <div style={{ maxWidth: 560 }}>
              <div style={{ marginBottom: 20 }}>
                <SectionHeader color={OP_TYPE_COLORS[selected.input.type] ?? "var(--accent)"} shape="square" label={selected.name} />
                {selected.description && (
                  <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
                    {selected.description}
                  </p>
                )}
              </div>

              {/* Environment selector */}
              <div style={{ marginBottom: 16 }}>
                <div className="section-label" style={{ marginBottom: 6 }}>Environment</div>
                <select
                  value={applyEnvId}
                  onChange={(e) => setApplyEnvId(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    fontSize: 13,
                  }}
                >
                  <option value="">No specific environment</option>
                  {(envs ?? []).map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>

              {/* Parameter inputs */}
              {selected.parameters.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div className="section-label" style={{ marginBottom: 8 }}>Parameters</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {selected.parameters.map((p) => (
                      <div key={p.name}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                          {p.name}
                          {p.description && (
                            <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
                              — {p.description}
                            </span>
                          )}
                        </div>
                        <input
                          type="text"
                          value={applyParams[p.name] ?? ""}
                          onChange={(e) => setApplyParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                          placeholder={p.defaultValue ?? `{{${p.name}}}`}
                          style={{
                            width: "100%",
                            padding: "7px 10px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--surface)",
                            color: "var(--text)",
                            fontSize: 13,
                            fontFamily: "var(--font-mono)",
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {applyError && (
                <div style={{ padding: "8px 12px", borderRadius: 6, background: "color-mix(in srgb, var(--status-failed) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--status-failed) 30%, transparent)", color: "var(--status-failed)", fontSize: 12, marginBottom: 12 }}>
                  {applyError}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  className="btn btn-primary"
                  onClick={handleApply}
                  disabled={applying}
                  style={{ fontSize: 13, padding: "8px 18px" }}
                >
                  {applying ? "Applying…" : "Apply Template"}
                </button>
                <button
                  className="btn"
                  onClick={() => handleDelete(selected)}
                  disabled={deleting}
                  style={{ fontSize: 12, padding: "8px 14px", color: "var(--status-failed)", borderColor: "color-mix(in srgb, var(--status-failed) 30%, transparent)" }}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
