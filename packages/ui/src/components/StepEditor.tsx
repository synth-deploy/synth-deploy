import { useState } from "react";
import type { DeploymentStep, DeploymentStepType } from "../types.js";

interface Props {
  steps: DeploymentStep[];
  onAdd: (step: { name: string; type: DeploymentStepType; command: string; order?: number }) => Promise<void>;
  onUpdate: (stepId: string, updates: Partial<DeploymentStep>) => Promise<void>;
  onDelete: (stepId: string) => Promise<void>;
}

const STEP_TYPES: DeploymentStepType[] = ["pre-deploy", "post-deploy", "verification"];

export default function StepEditor({ steps, onAdd, onUpdate, onDelete }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<DeploymentStepType>("pre-deploy");
  const [command, setCommand] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<DeploymentStep>>({});
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (!name.trim() || !command.trim()) return;
    setError(null);
    try {
      await onAdd({ name: name.trim(), type, command: command.trim(), order: steps.length });
      setName("");
      setCommand("");
      setType("pre-deploy");
    } catch (e: any) {
      setError(e.message);
    }
  }

  function startEdit(step: DeploymentStep) {
    setEditingId(step.id);
    setEditDraft({ name: step.name, type: step.type, command: step.command, order: step.order });
  }

  async function saveEdit(stepId: string) {
    setError(null);
    try {
      await onUpdate(stepId, editDraft);
      setEditingId(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  const sorted = [...steps].sort((a, b) => a.order - b.order);

  return (
    <div>
      {error && <div className="error-msg">{error}</div>}

      {sorted.length > 0 && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th>Name</th>
                <th>Type</th>
                <th>Command</th>
                <th style={{ width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((step) =>
                editingId === step.id ? (
                  <tr key={step.id}>
                    <td>
                      <input
                        type="number"
                        value={editDraft.order ?? 0}
                        onChange={(e) => setEditDraft({ ...editDraft, order: Number(e.target.value) })}
                        style={{ width: 40 }}
                      />
                    </td>
                    <td>
                      <input
                        value={editDraft.name ?? ""}
                        onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        value={editDraft.type ?? "pre-deploy"}
                        onChange={(e) => setEditDraft({ ...editDraft, type: e.target.value as DeploymentStepType })}
                      >
                        {STEP_TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={editDraft.command ?? ""}
                        onChange={(e) => setEditDraft({ ...editDraft, command: e.target.value })}
                        className="mono"
                      />
                    </td>
                    <td>
                      <button className="btn btn-sm" onClick={() => saveEdit(step.id)}>Save</button>
                      <button className="btn btn-sm" onClick={() => setEditingId(null)} style={{ marginLeft: 4 }}>Cancel</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={step.id}>
                    <td className="text-muted">{step.order}</td>
                    <td style={{ fontWeight: 500 }}>{step.name}</td>
                    <td>
                      <span className={`step-type-badge step-type-${step.type}`}>
                        {step.type}
                      </span>
                    </td>
                    <td className="mono">{step.command}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => startEdit(step)}>Edit</button>
                      <button className="btn btn-sm btn-danger-text" onClick={() => onDelete(step.id)} style={{ marginLeft: 4 }}>Delete</button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {sorted.length === 0 && (
        <p className="text-muted" style={{ margin: "12px 0" }}>No deployment steps defined. Add one below.</p>
      )}

      <div className="step-add-form">
        <input
          placeholder="Step name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={type} onChange={(e) => setType(e.target.value as DeploymentStepType)}>
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          placeholder="Command (e.g., npm run migrate)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="mono"
          style={{ flex: 1 }}
        />
        <button className="btn btn-primary" onClick={handleAdd}>Add Step</button>
      </div>
    </div>
  );
}
