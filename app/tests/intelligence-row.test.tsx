import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntelligenceRow } from "@/components/app-sidebar/intelligence-row";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import {
  type DashboardFailure,
  dashboardFailureSaid,
  readOffer,
  type ShellIpc,
} from "@/lib/desktop/intelligence-dashboard";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * The Desktop shell as the page sees it: Tauri's injected IPC. `say` delivers a channel message the
 * way Tauri does, `{ message, index }`; `refuse` makes `watch` reject, as it does for an origin the
 * shell never allowed or a Desktop without the plugin.
 */
function fakeShell({ refuse = false } = {}) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const callbacks = new Map<number, (message: unknown) => void>();
  let index = 0;
  let open: () => Promise<unknown> = async () => null;
  const shell: ShellIpc = {
    transformCallback: (callback) => {
      const id = callbacks.size + 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command.endsWith("|watch")) {
        if (refuse) throw new Error("not allowed");
        return null;
      }
      return open();
    },
  };
  return {
    shell,
    calls,
    say(message: unknown) {
      const channel = [...callbacks.values()].at(-1);
      act(() => channel?.({ message, index: index++ }));
    },
    openWith(next: () => Promise<unknown>) {
      open = next;
    },
  };
}

function draw(shell: ShellIpc | null) {
  return render(
    <SidebarProvider>
      <SidebarMenu>
        <IntelligenceRow shell={shell} />
      </SidebarMenu>
    </SidebarProvider>,
  );
}

test("the row is not drawn in a plain browser", () => {
  const view = draw(null);
  expect(view.queryByRole("button", { name: /Intelligence/ })).toBeNull();
});

test("the row is not drawn until Desktop says a local stack can be opened", async () => {
  const desktop = fakeShell();
  const view = draw(desktop.shell);
  await waitFor(() =>
    expect(desktop.calls.map((call) => call.command)).toEqual([
      "plugin:openbot-intelligence|watch",
    ]),
  );
  // The channel is handed over in Tauri's own form.
  expect(desktop.calls[0]?.args).toEqual({ onOffer: "__CHANNEL__:1" });
  desktop.say({ state: "unavailable" });
  expect(view.queryByRole("button", { name: /Intelligence/ })).toBeNull();
  desktop.say({ state: "ready" });
  expect(view.getByRole("button", { name: "Intelligence" })).toBeTruthy();
  // Hosted Intelligence, or local mode turned off: gone again.
  desktop.say({ state: "unavailable" });
  expect(view.queryByRole("button", { name: /Intelligence/ })).toBeNull();
});

test("a shell that refuses this page draws no row", async () => {
  const desktop = fakeShell({ refuse: true });
  const view = draw(desktop.shell);
  await waitFor(() => expect(desktop.calls).toHaveLength(1));
  expect(view.queryByRole("button", { name: /Intelligence/ })).toBeNull();
});

test("pressing the row spins and disables it at once, until the browser has the dashboard", async () => {
  const desktop = fakeShell();
  const view = draw(desktop.shell);
  await waitFor(() => expect(desktop.calls).toHaveLength(1));
  desktop.say({ state: "ready" });
  await userEvent.click(view.getByRole("button", { name: "Intelligence" }));
  // Before the shell has said anything back.
  const busy = view.getByRole("button", { name: "Opening…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(desktop.calls.at(-1)?.command).toBe(
    "plugin:openbot-intelligence|open",
  );
  desktop.say({ state: "opening" });
  expect(view.getByRole("button", { name: "Opening…" })).toBeTruthy();
  desktop.say({ state: "ready" });
  const ready = view.getByRole("button", { name: "Intelligence" });
  expect(ready.hasAttribute("disabled")).toBe(false);
  expect(view.queryByRole("status")).toBeNull();
});

test("an opening started from Desktop's menu spins the row too", async () => {
  const desktop = fakeShell();
  const view = draw(desktop.shell);
  await waitFor(() => expect(desktop.calls).toHaveLength(1));
  desktop.say({ state: "opening" });
  expect(
    view.getByRole("button", { name: "Opening…" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(desktop.calls).toHaveLength(1);
});

test("a failure is said under the row in a short fixed sentence, and the row can be pressed again", async () => {
  const desktop = fakeShell();
  const view = draw(desktop.shell);
  await waitFor(() => expect(desktop.calls).toHaveLength(1));
  desktop.say({ state: "ready" });
  await userEvent.click(view.getByRole("button", { name: "Intelligence" }));
  desktop.say({ state: "failed", reason: "not_responding" });
  expect(view.getByRole("status").textContent).toBe(
    "Intelligence is not responding yet. Try again shortly.",
  );
  expect(
    view.getByRole("button", { name: "Intelligence" }).hasAttribute("disabled"),
  ).toBe(false);
  // Pressing again clears it.
  await userEvent.click(view.getByRole("button", { name: "Intelligence" }));
  expect(view.queryByRole("status")).toBeNull();
});

test("a shell that cannot start the opening is said as a failure", async () => {
  const desktop = fakeShell();
  desktop.openWith(async () => {
    throw new Error("refused");
  });
  const view = draw(desktop.shell);
  await waitFor(() => expect(desktop.calls).toHaveLength(1));
  desktop.say({ state: "ready" });
  await userEvent.click(view.getByRole("button", { name: "Intelligence" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe(
      "OpenBot could not open Intelligence. Try again.",
    ),
  );
});

test("every failure category has its own sentence, and anything else is the general one", () => {
  const reasons: DashboardFailure[] = [
    "not_set_up",
    "not_responding",
    "browser_failed",
    "busy",
    "engine_stopped",
    "unsupported",
    "timed_out",
    "stopped",
    "failed",
  ];
  const said = reasons.map(dashboardFailureSaid);
  expect(new Set(said).size).toBe(reasons.length);
  for (const sentence of said) expect(sentence).toMatch(/^[A-Z].*\.$/);
  expect(
    readOffer({ state: "failed", reason: "https://leak.example" }),
  ).toEqual({ state: "failed", reason: "failed" });
  expect(readOffer({ state: "open-everything" })).toBeNull();
  expect(readOffer("ready")).toBeNull();
});
