import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type Listener = (event: Event & { detail?: { clean?: boolean } }) => void;

class FakeRFB {
  static instances: FakeRFB[] = [];

  readonly listeners = new Map<string, Set<Listener>>();
  viewOnly = false;
  scaleViewport = false;
  resizeSession = false;
  clipViewport = false;
  focusOnClick = false;
  qualityLevel = 0;
  compressionLevel = 0;

  constructor(
    readonly target: HTMLElement,
    readonly url: string,
    readonly options?: { wsProtocols?: string[] },
  ) {
    FakeRFB.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, detail: { clean?: boolean } = {}) {
    const event = Object.assign(new Event(type), { detail });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  focus() {}

  disconnect() {}
}

mock.module("@novnc/novnc/lib/rfb", () => ({ default: FakeRFB }));

GlobalRegistrator.register();
const { RemoteDesktop } = await import("@/components/computer/remote-desktop");

afterEach(() => {
  cleanup();
  FakeRFB.instances = [];
});
afterAll(() => GlobalRegistrator.unregister());

test("reconnects when the remote display closes its socket cleanly", async () => {
  const problems: Array<string | null> = [];
  render(
    <RemoteDesktop
      computerId="codex"
      driving={false}
      onProblem={(problem) => problems.push(problem)}
    />,
  );

  expect(FakeRFB.instances).toHaveLength(1);
  act(() => FakeRFB.instances[0]?.emit("connect"));
  act(() => FakeRFB.instances[0]?.emit("disconnect", { clean: true }));

  expect(problems.at(-1)).toBe(
    "The computer display disconnected. Reconnecting…",
  );
  await waitFor(() => expect(FakeRFB.instances).toHaveLength(2), {
    timeout: 1_500,
  });
});

test("uses interactive semantics only while the person has control", () => {
  const { getByRole, rerender } = render(
    <RemoteDesktop computerId="codex" driving={false} />,
  );
  expect(
    getByRole("img", { name: "The assistant's full computer, live" }),
  ).toBeTruthy();

  rerender(<RemoteDesktop computerId="codex" driving lease={"a".repeat(86)} />);
  expect(
    getByRole("application", {
      name: "The assistant's full computer. You have control.",
    }),
  ).toBeTruthy();
  expect(FakeRFB.instances.at(-1)?.options?.wsProtocols).toEqual([
    "binary",
    `openbot-lease.${"a".repeat(86)}`,
  ]);
});
