import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScanInput } from "./ScanInput";

function setup(props: Partial<Parameters<typeof ScanInput>[0]> = {}) {
  const onScan = vi.fn();
  render(<ScanInput label="Scan the thing" onScan={onScan} {...props} />);
  return { onScan, input: screen.getByLabelText("Scan the thing") as HTMLInputElement };
}

describe("ScanInput", () => {
  it("takes focus on mount and keeps the on-screen keyboard away while scanning", () => {
    const { input } = setup();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("inputmode", "none");
  });

  it("emits a scan when Enter (the wedge's terminator) arrives, then clears itself", async () => {
    const { onScan, input } = setup();
    await userEvent.setup().type(input, "ORD-42{Enter}");
    expect(onScan).toHaveBeenCalledExactlyOnceWith("ORD-42");
    expect(input).toHaveValue("");
  });

  it("strips control characters a scanner may append and ignores an empty scan", () => {
    const { onScan, input } = setup();
    fireEvent.change(input, { target: { value: "  BIN-7\t\r" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onScan).toHaveBeenCalledExactlyOnceWith("BIN-7");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onScan).toHaveBeenCalledOnce();
  });

  it("treats a bounced trigger (same code twice, back to back) as one scan", () => {
    const { onScan, input } = setup();
    for (let i = 0; i < 2; i++) {
      fireEvent.change(input, { target: { value: "BIN-7" } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(onScan).toHaveBeenCalledOnce();
  });

  it("does not submit on keys other than Enter", async () => {
    const { onScan, input } = setup();
    await userEvent.setup().type(input, "ABC");
    expect(onScan).not.toHaveBeenCalled();
    expect(input).toHaveValue("ABC");
  });

  it("pulls focus back after it is dropped on nothing, so the next scan is not lost", async () => {
    const { input } = setup();
    input.blur();
    await vi.waitFor(() => expect(input).toHaveFocus());
  });

  it("captures typing that lands on the page body (a scan while focus was lost)", () => {
    const { input } = setup();
    input.blur();
    document.body.focus();
    fireEvent.keyDown(document.body, { key: "A" });
    expect(input).toHaveFocus();
  });

  it("never steals focus from another field the operator chose", async () => {
    render(
      <>
        <input aria-label="other" />
        <ScanInput label="Scan the thing" onScan={() => undefined} />
      </>,
    );
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.keyDown(other, { key: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(other).toHaveFocus();
  });

  it("manual-entry fallback: 'Type instead' shows the keyboard and a large Enter button", async () => {
    const user = userEvent.setup();
    const { onScan, input } = setup();
    expect(screen.queryByRole("button", { name: "Enter" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Type instead" }));
    expect(input).toHaveAttribute("inputmode", "text");
    await vi.waitFor(() => expect(input).toHaveFocus());

    await user.type(input, "typed-by-hand");
    await user.click(screen.getByRole("button", { name: "Enter" }));
    expect(onScan).toHaveBeenCalledExactlyOnceWith("typed-by-hand");

    await user.click(screen.getByRole("button", { name: "Back to scanning" }));
    expect(input).toHaveAttribute("inputmode", "none");
  });

  it("is inert while disabled", () => {
    const { onScan, input } = setup({ disabled: true });
    expect(input).toBeDisabled();
    fireEvent.keyDown(document.body, { key: "A" });
    expect(onScan).not.toHaveBeenCalled();
  });
});
