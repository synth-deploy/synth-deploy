import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ConfirmDialog from "../src/components/ConfirmDialog";

describe("ConfirmDialog", () => {
  const defaultProps = {
    title: "Confirm Deletion",
    message: "Are you sure you want to delete this partition?",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders the title", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Confirm Deletion")).toBeInTheDocument();
  });

  it("renders the message", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Are you sure you want to delete this partition?")).toBeInTheDocument();
  });

  it("renders a cancel button", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("renders a confirm button with default label 'Delete'", () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("renders a confirm button with custom label", () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Remove" />);
    expect(screen.getByText("Remove")).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    await user.click(screen.getByText("Delete"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    await user.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the overlay is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    const overlay = document.querySelector(".confirm-overlay") as HTMLElement;
    await user.click(overlay);
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not call onCancel when dialog body is clicked (stopPropagation)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    const dialog = document.querySelector(".confirm-dialog") as HTMLElement;
    await user.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("confirm button has btn-danger class", () => {
    render(<ConfirmDialog {...defaultProps} />);
    const confirmBtn = screen.getByText("Delete");
    expect(confirmBtn).toHaveClass("btn-danger");
  });
});
