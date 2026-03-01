import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import EntityTag, { ENTITY_COLORS, type EntityType } from "../src/components/EntityTag";

describe("EntityTag", () => {
  it("renders the entity type and label", () => {
    render(<EntityTag type="Envoy" label="prod-west" />);
    expect(screen.getByText(/Envoy/)).toBeInTheDocument();
    expect(screen.getByText(/prod-west/)).toBeInTheDocument();
  });

  it("applies correct styling for Envoy type", () => {
    render(<EntityTag type="Envoy" label="test" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag).toHaveStyle({ color: ENTITY_COLORS.Envoy.color });
    expect(tag).toHaveStyle({ background: ENTITY_COLORS.Envoy.bg });
  });

  it("applies correct styling for Partition type", () => {
    render(<EntityTag type="Partition" label="shard-1" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag).toHaveStyle({ color: ENTITY_COLORS.Partition.color });
  });

  it("applies correct styling for Operation type", () => {
    render(<EntityTag type="Operation" label="deploy-v3" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag).toHaveStyle({ color: ENTITY_COLORS.Operation.color });
  });

  it("applies correct styling for Order type", () => {
    render(<EntityTag type="Order" label="order-42" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag).toHaveStyle({ color: ENTITY_COLORS.Order.color });
  });

  it("applies correct styling for Debrief type", () => {
    render(<EntityTag type="Debrief" label="debrief-7" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag).toHaveStyle({ color: ENTITY_COLORS.Debrief.color });
  });

  it("applies correct styling for Command type", () => {
    render(<EntityTag type="Command" label="cmd-1" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag).toHaveStyle({ color: ENTITY_COLORS.Command.color });
  });

  it("renders each entity type with its unique styling", () => {
    const types: EntityType[] = ["Envoy", "Partition", "Operation", "Order", "Debrief", "Command"];
    for (const type of types) {
      const { unmount } = render(<EntityTag type={type} label="x" />);
      const tag = document.querySelector(".entity-tag") as HTMLElement;
      const expected = ENTITY_COLORS[type];
      expect(tag).toHaveStyle({ color: expected.color });
      expect(tag).toHaveStyle({ background: expected.bg });
      unmount();
    }
  });

  it("sets cursor to pointer when onClick is provided", () => {
    render(<EntityTag type="Envoy" label="click-me" onClick={() => {}} />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag.style.cursor).toBe("pointer");
  });

  it("sets cursor to default when onClick is not provided", () => {
    render(<EntityTag type="Envoy" label="no-click" />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    expect(tag.style.cursor).toBe("default");
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<EntityTag type="Envoy" label="clickable" onClick={handleClick} />);
    const tag = document.querySelector(".entity-tag") as HTMLElement;
    await user.click(tag);
    expect(handleClick).toHaveBeenCalledOnce();
  });
});
