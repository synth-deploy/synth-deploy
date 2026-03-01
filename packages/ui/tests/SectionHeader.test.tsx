import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import SectionHeader from "../src/components/SectionHeader";

describe("SectionHeader", () => {
  it("renders the label text", () => {
    render(<SectionHeader color="#fff" shape="square" label="Partitions" />);
    expect(screen.getByText("Partitions")).toBeInTheDocument();
  });

  it("renders the label with a count", () => {
    render(<SectionHeader color="#fff" shape="square" label="Partitions" count={5} />);
    expect(screen.getByText("Partitions (5)")).toBeInTheDocument();
  });

  it("renders count of zero", () => {
    render(<SectionHeader color="#fff" shape="square" label="Envoys" count={0} />);
    expect(screen.getByText("Envoys (0)")).toBeInTheDocument();
  });

  it("does not render count when not provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Operations" />);
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
  });

  it("renders a square shape indicator", () => {
    render(<SectionHeader color="#818cf8" shape="square" label="Test" />);
    const shape = document.querySelector(".v2-section-shape") as HTMLElement;
    expect(shape.style.borderRadius).toBe("2px");
    expect(shape).toHaveStyle({ background: "#818cf8" });
  });

  it("renders a circle shape indicator", () => {
    render(<SectionHeader color="#34d399" shape="circle" label="Test" />);
    const shape = document.querySelector(".v2-section-shape") as HTMLElement;
    expect(shape.style.borderRadius).toBe("50%");
    expect(shape).toHaveStyle({ background: "#34d399" });
  });

  it("renders a hollow shape indicator with border and transparent background", () => {
    render(<SectionHeader color="#f59e0b" shape="hollow" label="Test" />);
    const shape = document.querySelector(".v2-section-shape") as HTMLElement;
    expect(shape.style.background).toBe("transparent");
    expect(shape).toHaveStyle({ border: `2px solid #f59e0b` });
  });

  it("renders a diamond shape indicator with rotation", () => {
    render(<SectionHeader color="#e879f9" shape="diamond" label="Test" />);
    const shape = document.querySelector(".v2-section-shape") as HTMLElement;
    expect(shape.style.transform).toBe("rotate(45deg)");
  });

  it("calls onClick when the label is clicked", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<SectionHeader color="#fff" shape="square" label="Clickable" onClick={handleClick} />);
    await user.click(screen.getByText("Clickable"));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("shows 'click to manage' hint when onClick is provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Managed" onClick={() => {}} />);
    expect(document.querySelector(".v2-section-manage")).toBeInTheDocument();
  });

  it("does not show 'click to manage' hint when onClick is not provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Static" />);
    expect(document.querySelector(".v2-section-manage")).not.toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Deployments" subtitle="recent" />);
    const subtitle = document.querySelector(".v2-section-subtitle");
    expect(subtitle).toBeInTheDocument();
    expect(subtitle!.textContent).toContain("recent");
  });

  it("does not render subtitle when not provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Deployments" />);
    expect(document.querySelector(".v2-section-subtitle")).not.toBeInTheDocument();
  });

  it("sets cursor to pointer on label when onClick is provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Pointer" onClick={() => {}} />);
    const label = document.querySelector(".v2-section-label") as HTMLElement;
    expect(label.style.cursor).toBe("pointer");
  });

  it("sets cursor to default on label when onClick is not provided", () => {
    render(<SectionHeader color="#fff" shape="square" label="Default" />);
    const label = document.querySelector(".v2-section-label") as HTMLElement;
    expect(label.style.cursor).toBe("default");
  });
});
