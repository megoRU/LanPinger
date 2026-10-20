import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

type MockEvent = { payload: unknown };
type EventHandler = (event: MockEvent) => void;

const harness = vi.hoisted(() => ({
  handlers: {} as Record<string, EventHandler>,
  invoke: vi.fn(),
  listen: vi.fn(),
  showWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: harness.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ show: harness.showWindow }) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: EventHandler) => {
    harness.handlers[name] = handler;
    return () => { delete harness.handlers[name]; };
  },
}));

describe("LanPinger interface", () => {
  beforeEach(async () => {
    harness.handlers = {};
    harness.invoke.mockReset();
    harness.invoke.mockImplementation(async (command: string) => command === "start_monitoring" ? "session-1" : undefined);
    harness.showWindow.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    render(<App />);
    await screen.findByRole("textbox", { name: "Host name or IP address" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops a monitor through the Rust commands", async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Host name or IP address" }), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(harness.invoke).toHaveBeenCalledWith("start_monitoring", { host: "example.com", intervalMs: 1_000 }));
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(harness.invoke).toHaveBeenCalledWith("stop_monitoring"));
  });

  it("updates route rows from the batched Rust event", async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Host name or IP address" }), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(harness.handlers["monitor-update"]).toBeDefined());

    await act(async () => {
      harness.handlers["monitor-update"]({
        payload: {
          sessionId: "session-1",
          host: "example.com",
          resolvedIp: "192.0.2.1",
          elapsedMs: 2_400,
          currentHop: 3,
          maxHops: 24,
          reachedDestination: true,
          rows: [{
            hop: 3,
            host: "edge.example.net",
            ip: "192.0.2.1",
            sent: 2,
            received: 2,
            lossPercent: 0,
            bestMs: 12.1,
            averageMs: 14.4,
            worstMs: 16.7,
            lastMs: 16.7,
            jitterMs: 4.6,
            status: "destination",
          }],
        },
      });
    });

    const destinationRow = screen.getByRole("row", { name: /edge\.example\.net/ });
    expect(within(destinationRow).getByText("edge.example.net")).toBeInTheDocument();
    expect(within(destinationRow).getByText("192.0.2.1")).toBeInTheDocument();
    expect(within(destinationRow).getByText("Destination")).toBeInTheDocument();
    expect(screen.getByText("2 replies / 2 probes")).toBeInTheDocument();
  });

  it("shows Rust validation and network errors without filling the table", async () => {
    harness.invoke.mockRejectedValueOnce("The host name contains an invalid character.");
    fireEvent.change(screen.getByRole("textbox", { name: "Host name or IP address" }), { target: { value: "bad;host" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Trace could not start")).toBeInTheDocument();
    expect(screen.getAllByText("The host name contains an invalid character.").length).toBeGreaterThan(0);
    expect(screen.queryByText("No route data yet")).not.toBeInTheDocument();
  });

  it("supports starting from the keyboard", async () => {
    const input = screen.getByRole("textbox", { name: "Host name or IP address" });
    fireEvent.change(input, { target: { value: "192.0.2.8" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(harness.invoke).toHaveBeenCalledWith("start_monitoring", { host: "192.0.2.8", intervalMs: 1_000 }));
  });
});
