import { useState } from "react";
import type { StepTypeDefinition, StepTypeParameter, DeploymentStepType } from "../types.js";

interface Props {
  stepType: StepTypeDefinition;
  onSubmit: (data: {
    name: string;
    type: DeploymentStepType;
    stepTypeId: string;
    stepTypeConfig: Record<string, unknown>;
  }) => void;
  onBack: () => void;
}

const STEP_TYPES: DeploymentStepType[] = ["pre-deploy", "post-deploy", "verification"];

function getDefaultValue(param: StepTypeParameter): string | number | boolean {
  if (param.default !== undefined) return param.default;
  if (param.type === "boolean") return false;
  if (param.type === "number") return "";
  if (param.type === "select" && param.options?.length) return param.options[0];
  return "";
}

export default function StepTypeForm({ stepType, onSubmit, onBack }: Props) {
  const [name, setName] = useState(stepType.name);
  const [deployType, setDeployType] = useState<DeploymentStepType>("pre-deploy");
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const p of stepType.parameters) {
      init[p.name] = getDefaultValue(p);
    }
    return init;
  });
  const [error, setError] = useState<string | null>(null);

  function setValue(paramName: string, value: unknown) {
    setValues((prev) => ({ ...prev, [paramName]: value }));
  }

  function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError("Step name is required");
      return;
    }

    // Validate required parameters
    for (const param of stepType.parameters) {
      if (param.required) {
        const val = values[param.name];
        if (val === undefined || val === null || val === "") {
          setError(`${param.label} is required`);
          return;
        }
      }
    }

    onSubmit({
      name: name.trim(),
      type: deployType,
      stepTypeId: stepType.id,
      stepTypeConfig: values,
    });
  }

  return (
    <div className="step-type-form">
      <div className="step-type-form-header">
        <button className="btn btn-sm" onClick={onBack}>&larr; Back</button>
        <h4>{stepType.name}</h4>
        <span className="text-muted">{stepType.description}</span>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="step-type-form-fields">
        <div className="form-group">
          <label>Step Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Deploy Phase</label>
          <select value={deployType} onChange={(e) => setDeployType(e.target.value as DeploymentStepType)}>
            {STEP_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        {stepType.parameters.map((param) => (
          <div className="form-group" key={param.name}>
            <label>
              {param.label}
              {param.required && <span className="required-star"> *</span>}
            </label>
            {param.description && (
              <span className="form-hint">{param.description}</span>
            )}
            {renderParameterInput(param, values[param.name], (v) => setValue(param.name, v))}
          </div>
        ))}
      </div>

      <div className="step-type-form-actions">
        <button className="btn" onClick={onBack}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSubmit}>Add Step</button>
      </div>
    </div>
  );
}

function renderParameterInput(
  param: StepTypeParameter,
  value: unknown,
  onChange: (value: unknown) => void,
) {
  switch (param.type) {
    case "boolean":
      return (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {" "}Enabled
        </label>
      );
    case "number":
      return (
        <input
          type="number"
          value={value === "" ? "" : String(value ?? "")}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          min={param.validation?.min}
          max={param.validation?.max}
        />
      );
    case "select":
      return (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {param.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    default:
      return (
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.description}
          className={param.name === "command" ? "mono" : ""}
        />
      );
  }
}
