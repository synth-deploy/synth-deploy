import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import StatusBadge from "../src/components/StatusBadge";
import type { DeploymentStatus } from "../src/types";

describe("StatusBadge", () => {
  it("renders with succeeded status", () => {
    render(<StatusBadge status="succeeded" />);
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
  });

  it("renders with failed status", () => {
    render(<StatusBadge status="failed" />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("renders with running status", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("renders with pending status", () => {
    render(<StatusBadge status="pending" />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders with rolled_back status", () => {
    render(<StatusBadge status="rolled_back" />);
    expect(screen.getByText("Rolled Back")).toBeInTheDocument();
  });

  it("applies the correct CSS class for each status", () => {
    const statuses: DeploymentStatus[] = ["succeeded", "failed", "running", "pending", "rolled_back"];
    for (const status of statuses) {
      const { unmount } = render(<StatusBadge status={status} />);
      const badge = document.querySelector(".badge") as HTMLElement;
      expect(badge).toHaveClass("badge", `badge-${status}`);
      unmount();
    }
  });

  it("has the badge base class on every variant", () => {
    render(<StatusBadge status="succeeded" />);
    const badge = screen.getByText("Succeeded");
    expect(badge).toHaveClass("badge");
  });
});
