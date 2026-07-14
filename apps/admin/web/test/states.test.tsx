import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, ErrorState, LoadingState, QueryState } from "../src/components";

describe("data states", () => {
  it("announces loading state", () => {
    render(<LoadingState rows={2} />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("provides an explicit empty state", () => {
    render(<EmptyState title="No runs" detail="Create the first bounded run." />);
    expect(screen.getByText("No runs")).toBeInTheDocument();
    expect(screen.getByText("Create the first bounded run.")).toBeInTheDocument();
  });

  it("announces errors and lets the operator retry", async () => {
    const retry = vi.fn();
    render(<ErrorState error={new Error("database unavailable")} retry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("database unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps last-known data visible when a background refresh fails", async () => {
    const retry = vi.fn();
    render(<QueryState query={{
      isPending: false,
      error: new Error("temporary disconnect"),
      refetch: retry,
      data: { data: { count: 3 }, source: "api", fallbackReason: null },
    }}>{(data) => <div>Visible runs: {data.count}</div>}</QueryState>);

    expect(screen.getByText("Visible runs: 3")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("temporary disconnect");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
