/**
 * Settings → This computer says what OpenBot runs in plain words, as the desktop app's Status window
 * does. It said "Back end", "Podman" or "Docker", and the build's commit and time, on a page any
 * Desktop user opens. The technical names stay in Copy diagnostics and the logs, for support.
 *
 * The IPC Tauri injects into the Desktop window is the stand-in, answering as the shell's
 * `openbot-desktop` plugin does (desktop/src-tauri/src/desktop_page.rs); the page is the real one.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import type { DesktopStatus } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

/** A Mac on Podman with everything up, as `docker stats` and the shell report it. */
const RUNNING: DesktopStatus = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [],
  containers: [
    { name: "openbot-desktop-server-1", memoryBytes: 412_000_000 },
    { name: "openbot-desktop-postgres-1", memoryBytes: 148_000_000 },
    { name: "openbot-desktop-sidecar-1", memoryBytes: null },
  ],
  intelligenceStack: "local-e0cf90debea88453ad454b93",
  intelligenceContainers: [
    {
      name: "k3d-local-e0cf90debea88453ad454b93-server-0",
      memoryBytes: 2_380_000_000,
    },
    {
      name: "k3d-local-e0cf90debea88453ad454b93-serverlb",
      memoryBytes: 21_000_000,
    },
  ],
  engine: "podman",
  root: "/Users/me/OpenBot",
  appPort: 3010,
  version: "1.0.1",
  build: "Built 2026-11-09 18:30 UTC from 795f619 on main",
};

/** Nothing running, and the software OpenBot runs on not answering. */
const STOPPED: DesktopStatus = {
  ...RUNNING,
  openbotRunning: false,
  openbotHeld: false,
  containers: [],
  intelligenceContainers: [],
  engine: null,
  appPort: null,
};

/**
 * Words a person on this page doesn't know, and values only support needs. Docker Desktop is named
 * where the person opens it; Docker alone, as the engine's name, is not.
 */
const TECHNICAL = [
  /Podman/i,
  /\bDocker\b(?! Desktop)/,
  /\bengines?\b/i,
  /back[ -]?end/i,
  /front[ -]?end/i,
  /\bcontainers?\b/i,
  /\bk3[sd]\b/i,
  /Intelligence/,
  /\bCLI\b/,
  /\bCompose\b/,
  /\bstack\b/i,
  /\bports?\b/i,
  /\bUTC\b/,
  /\bBuilt\b/,
  /\b[0-9a-f]{7,40}\b/,
  /openbot-desktop-|local-[0-9a-f]/,
  /—/,
];

let status: DesktopStatus;

async function shellInvoke(command: string) {
  if (command === "plugin:openbot-desktop|status") return status;
  if (command === "plugin:openbot-desktop|intelligence")
    return {
      outcome: "completed",
      readiness: status.intelligenceContainers.length ? "ready" : "stopped",
    };
  if (command === "plugin:openbot-desktop|update_offer")
    return { version: null, current: "1.0.1", installing: null };
  throw `command ${command} not found`;
}

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

test("every label and value on This computer is in plain words, and the technical detail is in Copy diagnostics", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  const Page = ThisComputerRoute.options.component as ComponentType;
  for (const [state, now] of [
    ["running", RUNNING],
    ["stopped", STOPPED],
  ] as const) {
    status = now;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );
    await view.findByText("Installed in");
    // Measured, and the readiness answered: everything the page will say is on it.
    await waitFor(() =>
      expect(view.container.textContent).toMatch(
        state === "running" ? /Ready.*in use/ : /Not using memory/,
      ),
    );
    const read = [
      view.container.textContent ?? "",
      ...[...view.container.querySelectorAll("[aria-label]")].map(
        (element) => element.getAttribute("aria-label") ?? "",
      ),
    ];
    const technical = read.flatMap((said) =>
      TECHNICAL.filter((word) => word.test(said)).map(
        (word) => said.match(word)?.[0],
      ),
    );
    expect({ state, technical }).toEqual({ state, technical: [] });
    // Each part is named as the setup window and the Status window name it.
    expect(
      view.getByRole("heading", { name: "OpenBot's services" }),
    ).toBeTruthy();
    expect(view.getByText("Software OpenBot runs on")).toBeTruthy();
    expect(view.getByText(`Version ${now.version}`)).toBeTruthy();
    // What support needs is one click away.
    await userEvent.click(
      view.getByRole("button", { name: "Copy diagnostics" }),
    );
    await waitFor(() => expect(copied).toContain(now.build));
    expect(copied).toContain(
      `Container engine: ${now.engine ?? "not answering"}`,
    );
    expect(copied).toContain("local-e0cf90debea88453ad454b93");
    cleanup();
    queryClient.clear();
  }
});
