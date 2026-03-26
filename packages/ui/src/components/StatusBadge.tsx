import type { DeploymentStatus } from "../types.js";

const labels: Record<DeploymentStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  planning: "Planning",
  approved: "Approved",
  awaiting_approval: "Awaiting Approval",
  rejected: "Rejected",
  shelved: "Shelved",
  rolled_back: "Rolled Back",
  cancelled: "Cancelled",
};

export default function StatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      {labels[status] ?? status}
    </span>
  );
}
