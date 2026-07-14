import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { NewRunButton } from "../src/new-run";
import { ApprovalsPage } from "../src/pages";
import { approvals, loops } from "../src/mock-data";
import { jsonResponse, renderApp } from "./test-utils";

afterEach(() => vi.restoreAllMocks());

const adminSession = { user: { id: "local-admin", name: "Local admin" }, role: "admin", permissions: { read: true, operate: true, administer: true } };
const unpaused = { paused: false, version: 1, changedAt: new Date().toISOString(), changedBy: "system", reason: "Ready" };

describe("Loop Engineering Admin", () => {
  it("falls back to clearly labelled demo data when the local API is offline", async () => {
    window.history.pushState({}, "", "/?demo=1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
    renderApp(<App />);

    expect(await screen.findByRole("heading", { name: "Operational overview" })).toBeInTheDocument();
    expect(screen.getByText("Demo data")).toBeInTheDocument();
    expect(screen.getByText("Add resumable uploads with clear recovery status and operator-safe retry controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New run/i })).toBeDisabled();
  });

  it("shows a real error instead of silently substituting demo records", async () => {
    window.history.pushState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
    renderApp(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("connection refused");
    expect(screen.queryByText("Add resumable uploads with clear recovery status and operator-safe retry controls")).not.toBeInTheDocument();
  });

  it("exposes objective, stages, attempts, checker separation, and requirement evidence", async () => {
    window.history.pushState({}, "", "/?demo=1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
    const user = userEvent.setup();
    renderApp(<App />, { route: "/runs/run-2048" });

    expect(await screen.findByRole("heading", { name: /Add resumable uploads/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Objective & acceptance requirements" })).toBeInTheDocument();
    expect(screen.getByText("Recover safely from checksum mismatch")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stage progression" })).toBeInTheDocument();
    expect(screen.getByText("Editing upload-resume.ts and preserving existing retry semantics")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Attempts/ }));
    expect(screen.getByRole("heading", { name: "Attempt 3" })).toBeInTheDocument();
    expect(screen.getByText("Retry of attempt 2")).toBeInTheDocument();
    expect(screen.getByText(/Rotate the stale upload token/)).toBeInTheDocument();
    expect(screen.getAllByText("Independent checker").length).toBeGreaterThan(0);
    expect(screen.getByText(/stale upload token is reused/i)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Verification & evidence/ }));
    expect(screen.getByRole("heading", { name: "Requirement traceability" })).toBeInTheDocument();
    expect(screen.getByText("21 focused state persistence tests passed.")).toBeInTheDocument();
    expect(screen.getByText("No current evidence bound")).toBeInTheDocument();
  });

  it("builds a general development run with project, runtime, and multiple requirements", async () => {
    window.history.pushState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/session") return jsonResponse(adminSession);
      if (String(input) === "/api/settings/global-pause") return jsonResponse(unpaused);
      return jsonResponse({ error: "not found" }, 404);
    }));
    const user = userEvent.setup();
    renderApp(<NewRunButton loops={loops} />);
    const newRun = screen.getByRole("button", { name: "New run" });
    await waitFor(() => expect(newRun).toBeEnabled());
    await user.click(newRun);

    expect(screen.getByRole("dialog", { name: "Create a queued loop run" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository path")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent runtime")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Acceptance criteria")).toBeRequired();

    await user.click(screen.getByRole("button", { name: "Add requirement" }));
    expect(screen.getByText("Requirement 2")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Acceptance criteria")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove requirement 2" }));
    expect(screen.queryByText("Requirement 2")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Create a queued loop run" })).not.toBeInTheDocument();
  });

  it("posts the complete run contract and navigates to the created run", async () => {
    window.history.pushState({}, "", "/");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session") return jsonResponse(adminSession);
      if (path === "/api/settings/global-pause") return jsonResponse(unpaused);
      if (path === "/api/runs" && init?.method === "POST") return jsonResponse({ id: "run-new" }, 201);
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderApp(<NewRunButton loops={loops} />);
    const newRun = screen.getByRole("button", { name: "New run" });
    await waitFor(() => expect(newRun).toBeEnabled());
    await user.click(newRun);
    await user.type(screen.getByLabelText("Project name"), "Payments API");
    await user.type(screen.getByLabelText("Repository path"), "/Users/me/Code/payments");
    await user.type(screen.getByLabelText(/^Objective/), "Make webhook retries idempotent and observable.");
    await user.type(screen.getByLabelText("Title"), "No duplicate delivery");
    await user.type(screen.getByLabelText("Description"), "Bound retries to one delivery key.");
    await user.type(screen.getByLabelText("Acceptance criteria"), "Concurrent retries produce one downstream delivery and a passing integration test.");
    await user.click(screen.getByRole("button", { name: "Create queued run" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs", expect.objectContaining({ method: "POST" })));
    const payload = JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/runs")?.[1]?.body));
    expect(payload).toEqual(expect.objectContaining({ projectName: "Payments API", repositoryPath: "/Users/me/Code/payments", runtime: "Codex CLI", requirements: [expect.objectContaining({ title: "No duplicate delivery", acceptanceCriteria: expect.stringContaining("Concurrent retries") })] }));
    expect(payload.stages).toHaveLength(12);
  });

  it("submits an approval decision with reason and optimistic version", async () => {
    window.history.pushState({}, "", "/");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session") return jsonResponse(adminSession);
      if (path === "/api/approvals" && (!init?.method || init.method === "GET")) return jsonResponse(approvals);
      if (path === "/api/approvals/approval-82/decision" && init?.method === "PATCH") return jsonResponse({ ...approvals[0], status: "rejected", version: 2 });
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderApp(<ApprovalsPage />, { route: "/approvals" });

    const review = await screen.findByRole("button", { name: "Review decision" });
    await waitFor(() => expect(review).toBeEnabled());
    await user.click(review);
    expect(screen.getByRole("button", { name: "Choose a decision" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Reject" }));
    await user.type(screen.getByLabelText("Decision reason"), "Evidence does not cover the shared fixture boundary.");
    await user.click(screen.getByRole("button", { name: "Reject action" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/approvals/approval-82/decision", expect.objectContaining({ method: "PATCH" })));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/approvals/approval-82/decision")?.[1]?.body));
    expect(body).toEqual({ decision: "rejected", reason: "Evidence does not cover the shared fixture boundary.", expectedVersion: 1 });
  });
});
