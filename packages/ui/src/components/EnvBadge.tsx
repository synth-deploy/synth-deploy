export interface EnvAgentData {
  successRate: string;
  envoyHealth: "OK" | "Degraded" | "Unreachable";
  drift: boolean;
  history: Array<"succeeded" | "failed">;
}

function envClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("prod")) return "env-badge-production";
  if (lower.includes("stag")) return "env-badge-staging";
  return "env-badge-default";
}

function envColor(name: string): { dot: string; text: string } {
  const lower = name.toLowerCase();
  if (lower.includes("prod")) return { dot: "#dc2626", text: "#dc2626" };
  if (lower.includes("stag")) return { dot: "#ca8a04", text: "#ca8a04" };
  return { dot: "#2563eb", text: "#2563eb" };
}

export default function EnvBadge({ name, agentData }: { name: string; agentData?: EnvAgentData }) {
  if (!agentData) {
    return (
      <span className={`env-badge ${envClass(name)}`}>
        {name}
      </span>
    );
  }

  const colors = envColor(name);
  const healthColor = agentData.envoyHealth === "OK" ? "#16a34a"
    : agentData.envoyHealth === "Degraded" ? "#ca8a04"
    : "#dc2626";

  return (
    <div className={`env-badge-expanded ${envClass(name)}`}>
      <div className="env-badge-expanded-header">
        <span className="env-badge-expanded-dot" style={{ background: colors.dot }} />
        <span className="env-badge-expanded-name" style={{ color: colors.text }}>{name}</span>
      </div>

      <div className="env-badge-expanded-body">
        <div className="env-badge-expanded-row">
          <span>Success rate</span>
          <span className="mono" style={{ color: colors.text }}>{agentData.successRate}</span>
        </div>
        <div className="env-badge-expanded-row">
          <span>Envoy</span>
          <span className="mono" style={{ color: healthColor }}>{agentData.envoyHealth}</span>
        </div>
        {agentData.drift && (
          <div className="env-badge-expanded-drift">Variable drift detected</div>
        )}
        {agentData.history.length > 0 && (
          <div className="env-badge-expanded-history">
            {agentData.history.map((h, i) => (
              <span
                key={i}
                className={`env-badge-history-dot ${h === "succeeded" ? "history-pass" : "history-fail"}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
