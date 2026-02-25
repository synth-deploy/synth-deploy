import type { DeploymentStatus } from "../types.js";

const labels: Record<DeploymentStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  rolled_back: "Rolled Back",
};

export default function StatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      {labels[status] ?? status}
    </span>
  );
}
