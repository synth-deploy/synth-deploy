import { useState } from "react";
import type { DeploymentStep, DeploymentStepType, StepTypeDefinition } from "../types.js";
import StepTypePicker from "./StepTypePicker.js";
import StepTypeForm from "./StepTypeForm.js";

interface Props {
  steps: DeploymentStep[];
  onAdd: (step: {
    name: string;
    type: DeploymentStepType;
    command?: string;
    order?: number;
    stepTypeId?: string;
    stepTypeConfig?: Record<string, unknown>;
  }) => Promise<void>;
  onUpdate: (stepId: string, updates: Partial<DeploymentStep>) => Promise<void>;
  onDelete: (stepId: string) => Promise<void>;
  onReorder: (stepIds: string[]) => Promise<void>;
}

const STEP_TYPES: DeploymentStepType[] = ["pre-deploy", "post-deploy", "verification"];

type AddMode = "closed" | "picker" | "form" | "freeform";

export default function StepEditor({ steps, onAdd, onUpdate, onDelete, onReorder }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<DeploymentStep>>({});
  const [error, setError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<AddMode>("closed");
  const [selectedStepType, setSelectedStepType] = useState<StepTypeDefinition | null>(null);

  // Freeform fields (for "Run Command" / manual entry)
  const [freeformName, setFreeformName] = useState("");
  const [freeformType, setFreeformType] = useState<DeploymentStepType>("pre-deploy");
  const [freeformCommand, setFreeformCommand] = useState("");

  function startEdit(step: DeploymentStep) {
    setEditingId(step.id);
    setEditDraft({ name: step.name, type: step.type, command: step.command });
  }

  async function handleMoveUp(index: number) {
    if (index <= 0) return;
    const ids = sorted.map((s) => s.id);
    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    setError(null);
    try {
      await onReorder(ids);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleMoveDown(index: number) {
    if (index >= sorted.length - 1) return;
    const ids = sorted.map((s) => s.id);
    [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
    setError(null);
    try {
      await onReorder(ids);
    } catch (e: any) {
      setError(e.message);
    }
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

  function handleStepTypeSelected(stepType: StepTypeDefinition) {
    setSelectedStepType(stepType);
    setAddMode("form");
  }

  async function handleStepTypeFormSubmit(data: {
    name: string;
    type: DeploymentStepType;
    stepTypeId: string;
    stepTypeConfig: Record<string, unknown>;
  }) {
    setError(null);
    try {
      await onAdd({
        name: data.name,
        type: data.type,
        stepTypeId: data.stepTypeId,
        stepTypeConfig: data.stepTypeConfig,
        order: steps.length,
      });
      setAddMode("closed");
      setSelectedStepType(null);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleFreeformAdd() {
    if (!freeformName.trim() || !freeformCommand.trim()) return;
    setError(null);
    try {
      await onAdd({
        name: freeformName.trim(),
        type: freeformType,
        command: freeformCommand.trim(),
        order: steps.length,
      });
      setFreeformName("");
      setFreeformCommand("");
      setFreeformType("pre-deploy");
      setAddMode("closed");
    } catch (e: any) {
      setError(e.message);
    }
  }

  function closeAdd() {
    setAddMode("closed");
    setSelectedStepType(null);
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
                <th style={{ width: 60 }}>Order</th>
                <th style={{ width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((step, i) =>
                editingId === step.id ? (
                  <tr key={step.id}>
                    <td className="text-muted">{i + 1}</td>
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
                    <td />
                    <td>
                      <button className="btn btn-sm" onClick={() => saveEdit(step.id)}>Save</button>
                      <button className="btn btn-sm" onClick={() => setEditingId(null)} style={{ marginLeft: 4 }}>Cancel</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={step.id}>
                    <td className="text-muted">{i + 1}</td>
                    <td style={{ fontWeight: 500 }}>{step.name}</td>
                    <td>
                      <span className={`step-type-badge step-type-${step.type}`}>
                        {step.type}
                      </span>
                    </td>
                    <td className="mono">{step.command}</td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => handleMoveUp(i)}
                        disabled={i === 0}
                        title="Move up"
                        style={{ padding: "2px 6px" }}
                      >&#9650;</button>
                      <button
                        className="btn btn-sm"
                        onClick={() => handleMoveDown(i)}
                        disabled={i === sorted.length - 1}
                        title="Move down"
                        style={{ padding: "2px 6px", marginLeft: 2 }}
                      >&#9660;</button>
                    </td>
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

      {/* Add step controls */}
      {addMode === "closed" && (
        <div className="step-add-buttons">
          <button className="btn btn-primary" onClick={() => setAddMode("picker")}>
            Add Step from Library
          </button>
          <button className="btn" onClick={() => setAddMode("freeform")}>
            Add Custom Command
          </button>
        </div>
      )}

      {addMode === "picker" && (
        <StepTypePicker
          onSelect={handleStepTypeSelected}
          onCancel={closeAdd}
        />
      )}

      {addMode === "form" && selectedStepType && (
        <StepTypeForm
          stepType={selectedStepType}
          onSubmit={handleStepTypeFormSubmit}
          onBack={() => setAddMode("picker")}
        />
      )}

      {addMode === "freeform" && (
        <div className="step-add-form">
          <input
            placeholder="Step name"
            value={freeformName}
            onChange={(e) => setFreeformName(e.target.value)}
          />
          <select value={freeformType} onChange={(e) => setFreeformType(e.target.value as DeploymentStepType)}>
            {STEP_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            placeholder="Command (e.g., npm run migrate)"
            value={freeformCommand}
            onChange={(e) => setFreeformCommand(e.target.value)}
            className="mono"
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleFreeformAdd}>Add Step</button>
          <button className="btn" onClick={closeAdd}>Cancel</button>
        </div>
      )}
    </div>
  );
}
