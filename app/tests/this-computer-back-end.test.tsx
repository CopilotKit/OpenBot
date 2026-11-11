/**
 * Settings → This computer: the OpenBot's services section, the local back end. Only OpenBot
 * Desktop has this page, and Desktop runs the personal edition, whose local Intelligence isn't
 * licensed for memory. So the section says nothing about a Bot's memory; how much of the
 * computer's memory it uses still shows.
 *
 * The IPC Tauri injects into the Desktop window is the stand-in, answering `status` as the shell's
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
import { cleanup, render, within } from "@testing-library/react";
import type { ComponentType } from "react";
import type { DesktopStatus } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

const STATUS: DesktopStatus = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [],
  containers: [],
  intelligenceStack: "local-abc",
  intelligenceContainers: [
    { name: "k3d-local-abc-server-0", memoryBytes: 1_200_000_000 },
  ],
  engine: "docker",
  root: "/Users/me/OpenBot",
  appPort: 3010,
  version: "0.3.2",
  build: "v0.3.2 (b214c97e)",
};

async function shellInvoke(command: string) {
  if (command === "plugin:openbot-desktop|status") return STATUS;
  if (command === "plugin:openbot-desktop|update_offer")
    return { version: null, current: "0.3.2", installing: null };
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

test("OpenBot's services say what they keep without mentioning memory", async () => {
  const Page = ThisComputerRoute.options.component as ComponentType;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
  const heading = await view.findByRole("heading", {
    name: "OpenBot's services",
  });
  const section = heading.closest("section") as HTMLElement;
  expect(
    within(section).getByText(
      "These keep your Bots' conversations and skills. OpenBot needs them while it runs.",
    ),
  ).toBeTruthy();
  expect(
    await within(section).findByText("Conversations and learning"),
  ).toBeTruthy();
  expect(section.textContent).not.toMatch(/conversations, memory/i);
});
