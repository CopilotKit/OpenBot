import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  SECURITY_FLOOR_ACTION,
  SECURITY_FLOOR_HEADING,
  SECURITY_FLOOR_LINE,
} from "@openbot/shared/security-floor";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import cases from "../../shared/fixtures/security-floor/cases.json";
import { installRecording } from "../src/background/recording";
import { installRouter } from "../src/background/router";
import { installSecurityFloor } from "../src/background/security-floor";
import { Popup } from "../src/pages/popup/popup";
import { SecurityFloorGate } from "../src/pages/ui/security-floor";
import type { ConnectionRecord } from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

// The popup as main.tsx draws it, against the service worker as index.ts installs it.

const current = cases.cases.find((c) => c.name === "current")?.document ?? "";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let fake: ChromeFake;
const realFetch = globalThis.fetch;
let originalMatchMedia: typeof window.matchMedia;
beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  // OpenBot answers whatever the popup asks of it when the floor lets it ask.
  globalThis.fetch = (async () =>
    Response.json({
      user: { id: "p1", name: "Ada", email: "ada@example.test" },
      connectionId: "c-obr_ada",
      learning: { state: "assigned", containerId: "space-1" },
    })) as unknown as typeof fetch;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  globalThis.fetch = realFetch;
  fake.uninstall();
});

async function serviceWorker(openbotUrl: string) {
  fake = installChromeFake({ manifestVersion: "1.1.1" });
  const connection: ConnectionRecord = {
    openbotUrl,
    token: "obr_ada",
    connectionId: "c-obr_ada",
    user: { id: "p1", name: "Ada", email: "ada@example.test" },
    via: "web",
    connectedAt: 1,
  };
  fake.storage.local.set("connection", connection);
  fake.storage.local.set("securityFloor", current);
  fake.native.reply = () => ({ ok: false, error: "not-running" });
  const floor = installSecurityFloor(installRecording(), {
    keys: [cases.publicKey],
    read: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
  });
  installRouter(floor.recording);
  // The start's own read of the feed (offline here) has finished, so nothing of it runs on after the test.
  await waitFor(() =>
    expect(fake.storage.local.has("securityFloorCheckedAt")).toBe(true),
  );
}

const popup = () =>
  render(
    <SecurityFloorGate width="popup">
      <Popup
        deps={{
          activeTabId: async () => 7,
          microphoneState: async () => "granted",
        }}
      />
    </SecurityFloorGate>,
  );

test("below the floor, the popup shows the one notice and nothing else", async () => {
  await serviceWorker("https://cloud.openbot.example");
  const view = popup();
  const heading = await view.findByRole("heading", {
    name: SECURITY_FLOOR_HEADING,
  });
  expect(heading).toBeTruthy();
  expect(view.getByRole("alert").textContent).toContain(SECURITY_FLOOR_LINE);
  // Nothing of the popup itself: no Record form, no connection, no other button.
  expect(view.queryByText("Ada")).toBeNull();
  expect(
    view.getAllByRole("button").map((button) => button.textContent),
  ).toEqual([SECURITY_FLOOR_ACTION]);
  fireEvent.click(view.getByRole("button", { name: SECURITY_FLOOR_ACTION }));
  await waitFor(() => expect(fake.update.reloads).toBe(1));
  expect(fake.calls).toContain("runtime.requestUpdateCheck");
});

test("connected to a company's own OpenBot, the popup is the popup", async () => {
  await serviceWorker("https://openbot.company.example");
  const view = popup();
  await view.findByText("Ada");
  expect(view.queryByText(SECURITY_FLOOR_HEADING)).toBeNull();
});
