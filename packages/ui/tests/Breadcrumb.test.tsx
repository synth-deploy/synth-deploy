import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Breadcrumb from "../src/components/Breadcrumb";

describe("Breadcrumb", () => {
  it("renders the DeployStack root label", () => {
    render(<Breadcrumb path={[]} onHome={() => {}} />);
    expect(screen.getByText("DeployStack")).toBeInTheDocument();
  });

  it("calls onHome when the root label is clicked", async () => {
    const user = userEvent.setup();
    const onHome = vi.fn();
    render(<Breadcrumb path={[]} onHome={onHome} />);
    await user.click(screen.getByText("DeployStack"));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("renders path segments", () => {
    render(
      <Breadcrumb
        path={[
          { label: "Partitions" },
          { label: "prod-east" },
        ]}
        onHome={() => {}}
      />,
    );
    expect(screen.getByText("Partitions")).toBeInTheDocument();
    expect(screen.getByText("prod-east")).toBeInTheDocument();
  });

  it("renders separators between segments", () => {
    render(
      <Breadcrumb
        path={[{ label: "A" }, { label: "B" }]}
        onHome={() => {}}
      />,
    );
    const separators = document.querySelectorAll(".v2-breadcrumb-separator");
    expect(separators).toHaveLength(2);
  });

  it("calls segment onClick when a clickable segment is clicked", async () => {
    const user = userEvent.setup();
    const segmentClick = vi.fn();
    render(
      <Breadcrumb
        path={[
          { label: "Partitions", onClick: segmentClick },
          { label: "prod-east" },
        ]}
        onHome={() => {}}
      />,
    );
    await user.click(screen.getByText("Partitions"));
    expect(segmentClick).toHaveBeenCalledOnce();
  });

  it("marks the last segment as current", () => {
    render(
      <Breadcrumb
        path={[
          { label: "Partitions" },
          { label: "prod-east" },
        ]}
        onHome={() => {}}
      />,
    );
    const lastItem = screen.getByText("prod-east");
    expect(lastItem).toHaveClass("v2-breadcrumb-current");
  });

  it("does not mark non-last segments as current", () => {
    render(
      <Breadcrumb
        path={[
          { label: "Partitions" },
          { label: "prod-east" },
        ]}
        onHome={() => {}}
      />,
    );
    const firstItem = screen.getByText("Partitions");
    expect(firstItem).not.toHaveClass("v2-breadcrumb-current");
  });

  it("sets cursor to pointer for segments with onClick", () => {
    render(
      <Breadcrumb
        path={[{ label: "Clickable", onClick: () => {} }]}
        onHome={() => {}}
      />,
    );
    const item = screen.getByText("Clickable");
    expect(item.style.cursor).toBe("pointer");
  });

  it("sets cursor to default for segments without onClick", () => {
    render(
      <Breadcrumb
        path={[{ label: "Static" }]}
        onHome={() => {}}
      />,
    );
    const item = screen.getByText("Static");
    expect(item.style.cursor).toBe("default");
  });
});
