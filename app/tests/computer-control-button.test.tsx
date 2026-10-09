import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import type { ControlState } from "@/lib/computers/control";
import {
  ComputerChatControls,
  ComputerControlButton,
} from "@/components/computer/computer-controls";

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function server(initial: "bot" | "human" = "bot") {
  let state: ControlState = {
    holder: initial,
    since: "2026-09-26T00:00:00Z",
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    ...(initial === "human"
      ? {
          request: {
            id: "request-1",
            status: "taken" as const,
            reason: "Please help",
            source: "manual" as const,
            createdAt: "2026-09-26T00:00:00Z",
            updatedAt: "2026-09-26T00:00:00Z",
          },
        }
      : {}),
  };
  const calls: { path: string; body: unknown }[] = [];
  let fail = false;
  let completeTake: (() => void) | undefined;
  let holdTake = false;
  globalThis.fetch = Object.assign(
    async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const path = String(url);
      const body: unknown = init?.body
        ? JSON.parse(String(init.body))
        : undefined;
      calls.push({ path, body });
      if (fail && path.endsWith("/control/take"))
        return Response.json({ error: "Unavailable" }, { status: 503 });
      if (path.endsWith("/control/request"))
        state = {
          ...state,
          requested: true,
          request: {
            id: "request-1",
            status: "waiting",
            reason: "Manual control",
            source: "manual",
            createdAt: state.since,
            updatedAt: state.since,
          },
        };
      if (path.endsWith("/control/take")) {
        if (holdTake)
          await new Promise<void>((resolve) => {
            completeTake = resolve;
          });
        if (state.request)
          state = {
            ...state,
            requested: false,
            holder: "human",
            request: { ...state.request, status: "taken" },
          };
      }
      if (path.endsWith("/control/release") && state.request)
        state = {
          ...state,
          holder: "bot",
          request: { ...state.request, status: "completed" },
        };
      return Response.json(state);
    },
    { preconnect: () => undefined },
  );
  return {
    calls,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
    delayTake: () => {
      holdTake = true;
    },
    finishTake: () => completeTake?.(),
    transition: () => {
      state = { ...state, transitioning: true };
    },
  };
}
function controls(botId = "control-test") {
  const view = render(
    <>
      <section aria-label="Chat">
        <ComputerControlButton computerId={botId} />
      </section>
      <section aria-label="Computer sidebar">
        <ComputerControlButton computerId={botId} />
      </section>
    </>,
  );
  return {
    ...view,
    chat: within(view.getByRole("region", { name: "Chat" })),
    sidebar: within(view.getByRole("region", { name: "Computer sidebar" })),
  };
}

test("chat and sidebar always show controls and update together using the exact request", async () => {
  const backend = server();
  const view = controls();
  await waitFor(() =>
    expect(
      view.chat
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  expect(
    await view.sidebar.findByRole("button", { name: "Hand back" }),
  ).toBeTruthy();
  expect(view.chat.getByRole("button", { name: "Hand back" })).toBeTruthy();
  fireEvent.click(view.sidebar.getByRole("button", { name: "Hand back" }));
  expect(
    await view.chat.findByRole("button", { name: "Take control" }),
  ).toBeTruthy();
  expect(
    backend.calls
      .filter(
        (call) =>
          call.path.endsWith("/control/take") ||
          call.path.endsWith("/control/release"),
      )
      .map((call) => call.body),
  ).toEqual([{ requestId: "request-1" }, { requestId: "request-1" }]);
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/request")),
  ).toHaveLength(1);
});

test("an in-flight takeover disables both controls and prevents duplicate requests", async () => {
  const backend = server();
  backend.delayTake();
  const view = controls();
  await waitFor(() =>
    expect(
      view.chat
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    expect(
      view.sidebar
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  fireEvent.click(view.sidebar.getByRole("button", { name: "Take control" }));
  backend.finishTake();
  await view.chat.findByRole("button", { name: "Hand back" });
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/take")),
  ).toHaveLength(1);
});

test("a failed takeover is visible in both surfaces and can be retried", async () => {
  const backend = server();
  backend.fail();
  const view = controls();
  await waitFor(() =>
    expect(
      view.chat
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  expect(await view.chat.findByRole("alert")).toBeTruthy();
  expect(view.sidebar.getByRole("alert")).toBeTruthy();
  backend.recover();
  fireEvent.click(view.sidebar.getByRole("button", { name: "Take control" }));
  expect(
    await view.chat.findByRole("button", { name: "Hand back" }),
  ).toBeTruthy();
  expect(view.chat.queryByRole("alert")).toBeNull();
});

test("active human control is immediately offered as Hand back on mounting either surface", async () => {
  server("human");
  const view = controls();
  expect(
    await view.chat.findByRole("button", { name: "Hand back" }),
  ).toBeTruthy();
  expect(view.sidebar.getByRole("button", { name: "Hand back" })).toBeTruthy();
});

test("Strict Mode keeps chat and sidebar on one ownership store", async () => {
  const backend = server();
  const view = render(
    <StrictMode>
      <ComputerControlButton computerId="strict-control" />
      <ComputerControlButton computerId="strict-control" />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      view
        .getAllByRole("button", { name: "Take control" })
        .every((button) => !button.hasAttribute("disabled")),
    ).toBe(true),
  );
  fireEvent.click(view.getAllByRole("button", { name: "Take control" })[0]!);
  await waitFor(() =>
    expect(view.getAllByRole("button", { name: "Hand back" })).toHaveLength(2),
  );
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/request")),
  ).toHaveLength(1);
});

test("a takeover stays shared when chat remounts before its response", async () => {
  const backend = server();
  backend.delayTake();
  const first = render(<ComputerControlButton computerId="remount-control" />);
  await waitFor(() =>
    expect(first.getByRole("button").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(first.getByRole("button"));
  await waitFor(() =>
    expect(
      backend.calls.some((call) => call.path.endsWith("/control/take")),
    ).toBe(true),
  );
  first.unmount();
  const second = render(<ComputerControlButton computerId="remount-control" />);
  expect(second.getByRole("button").hasAttribute("disabled")).toBe(true);
  backend.finishTake();
  expect(await second.findByRole("button", { name: "Hand back" })).toBeTruthy();
});

test("the header's Computer toggle is an icon alone; taking control lives in the Computer itself", async () => {
  const backend = server();
  function Chat() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <ComputerChatControls
          computerId="toggle-control"
          open={open}
          onOpenChange={setOpen}
        />
        {open ? <p>Live computer sidebar</p> : null}
      </>
    );
  }
  const view = render(<Chat />);
  const toggle = await view.findByRole("button", { name: "Open Computer" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.textContent).toBe("");
  expect(view.queryByRole("button", { name: "Take control" })).toBeNull();
  fireEvent.click(toggle);
  expect(view.getByText("Live computer sidebar")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close Computer" }));
  expect(view.queryByText("Live computer sidebar")).toBeNull();
  expect(backend.calls.filter((call) => call.body)).toHaveLength(0);
});

test("an active human prompt opens once and does not fight closing the Computer", async () => {
  server("human");
  function Chat() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <ComputerChatControls
          computerId="human-toggle"
          open={open}
          onOpenChange={(next) => setOpen(next)}
        />
        {open ? <p>Live computer sidebar</p> : null}
      </>
    );
  }
  const view = render(<Chat />);
  expect(await view.findByText("Live computer sidebar")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close Computer" }));
  view.rerender(<Chat />);
  expect(view.queryByText("Live computer sidebar")).toBeNull();
  // Closed, the icon still says the Computer wants the person; handing back is done inside it.
  expect(view.getByRole("img", { name: "Needs you" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Hand back" })).toBeNull();
});

test("both controls stay disabled while the current browser action drains", async () => {
  const backend = server();
  backend.transition();
  const view = controls("draining-control");
  expect(await view.chat.findByRole("status")).toBeTruthy();
  expect(view.sidebar.getByRole("status")).toBeTruthy();
  expect(
    view.chat
      .getByRole("button", { name: "Take control" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view.sidebar
      .getByRole("button", { name: "Take control" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  expect(backend.calls.filter((call) => call.body)).toHaveLength(0);
});
