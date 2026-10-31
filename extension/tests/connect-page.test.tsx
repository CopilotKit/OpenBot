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
  RECORDER_DESTINATION,
  RECORDER_DISCLOSURE,
} from "@openbot/shared/recorder-disclosure";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectPage } from "../src/pages/connect/connect-page";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const ORIGIN = "https://openbot.example.test";
let fake: ChromeFake;
let received: {
  type: string;
  approve?: boolean;
  label?: string;
  origin?: string;
}[];
let decideAnswer: unknown;
let pendingAnswer: unknown;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  fake = installChromeFake();
  received = [];
  decideAnswer = { ok: true };
  pendingAnswer = { ok: true, pending: { origin: ORIGIN, via: "web" } };
  originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: {
      brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }],
      platform: "macOS",
    },
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    received.push(message);
    if (message.type === "page.connect.pending") {
      reply(pendingAnswer);
    } else {
      reply(decideAnswer);
    }
    return true;
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  delete (navigator as unknown as Record<string, unknown>).userAgentData;
  fake.uninstall();
});

test("shows the origin and the default name", async () => {
  const { findByText, getByText } = render(<ConnectPage />);
  expect((await findByText(ORIGIN)).className).toContain("font-mono");
  // Any site can ask, so the page never says the request came from OpenBot.
  expect(
    getByText("A page at this address in this browser asked to connect."),
  ).toBeTruthy();
  expect(getByText("Google Chrome on macOS")).toBeTruthy();
});

test("a connect that would replace this browser's connection says so before the click, naming that OpenBot and the person", async () => {
  pendingAnswer = {
    ok: true,
    pending: { origin: ORIGIN, via: "web" },
    replaces: {
      origin: "https://other.example.test",
      email: "ada@example.test",
    },
  };
  const { findByText, getByText, container } = render(<ConnectPage />);
  await findByText(ORIGIN);
  expect(container.textContent).toContain(
    "This replaces your connection to https://other.example.test",
  );
  expect((await findByText("https://other.example.test")).className).toContain(
    "font-mono",
  );
  expect(getByText("Connected there as ada@example.test.")).toBeTruthy();
});

test("a connect that replaces nothing says nothing about replacing", async () => {
  const { findByText, container } = render(<ConnectPage />);
  await findByText(ORIGIN);
  expect(container.textContent).not.toContain("replaces");
});

test("the page says OpenBot signs the browser in, and that recordings go straight to the organization's own Intelligence with OpenBot's pass, as the disclosure says", async () => {
  const { findByText, container } = render(<ConnectPage />);
  await findByText(ORIGIN);
  expect(
    await findByText(
      "Confirm this is your OpenBot. It signs this browser in. What you record goes straight from your browser to your organization's own Intelligence, with a pass from your organization's OpenBot. OpenBot is told that you are recording, the task's name, when it started and how many steps it has, and when you record in a browser shown inside OpenBot, your narration passes through it to the Recorder without being stored.",
    ),
  ).toBeTruthy();
  expect(container.ownerDocument.body.textContent).toContain(
    RECORDER_DESTINATION,
  );
  // The disclosure says the same, and neither says the recording passes through OpenBot, which it never does.
  expect(RECORDER_DISCLOSURE).toContain(RECORDER_DESTINATION);
  for (const said of [
    RECORDER_DISCLOSURE,
    container.ownerDocument.body.textContent,
  ])
    expect(said).not.toMatch(/through (your organization's )?OpenBot/i);
  expect(container.ownerDocument.body.textContent).not.toMatch(
    /save (your )?recordings/i,
  );
});

test("the Name row opens a dialog whose Save changes the name and the label later sent", async () => {
  const { findByText, findByLabelText, getByText, getByRole } = render(
    <ConnectPage />,
  );
  const user = userEvent.setup({ document });
  await user.click((await findByText("Name")).closest("button") as HTMLElement);
  const input = (await findByLabelText(
    "Name this browser",
  )) as HTMLInputElement;
  await user.clear(input);
  await user.type(input, "Work laptop");
  await user.click(getByText("Save"));
  await waitFor(() => expect(getByText("Work laptop")).toBeTruthy());
  fireEvent.click(getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(
      getByText("Connected as Work laptop. You can close this tab."),
    ).toBeTruthy(),
  );
  expect(received.at(-1)).toEqual({
    type: "page.connect.decide",
    approve: true,
    label: "Work laptop",
    origin: ORIGIN,
  });
});

test("Connect asks for no permission: website access came with the install", async () => {
  // Chrome would refuse anything else here: the person's answer to a prompt is the only way to a grant.
  fake.permissions.answer = false;
  const { findByRole, findByText } = render(<ConnectPage />);
  fireEvent.click(await findByRole("button", { name: "Connect" }));
  await findByText(
    "Connected as Google Chrome on macOS. You can close this tab.",
  );
  expect(fake.permissions.requests).toEqual([]);
  expect(received.map((m) => m.type)).toEqual([
    "page.connect.pending",
    "page.connect.decide",
  ]);
});

test("a refusal from OpenBot shows its sentence", async () => {
  decideAnswer = { ok: false, error: "That code has expired." };
  const { findByRole, findByText } = render(<ConnectPage />);
  fireEvent.click(await findByRole("button", { name: "Connect" }));
  await findByText("That code has expired.");
});

test("Cancel sends approve false with the origin the page shows", async () => {
  const shown = "http://127.0.0.1:7470";
  pendingAnswer = { ok: true, pending: { origin: shown, via: "desktop" } };
  const { findByRole, getByText } = render(<ConnectPage />);
  fireEvent.click(await findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(received.at(-1)?.approve).toBe(false));
  expect(received.at(-1)).toEqual({
    type: "page.connect.decide",
    approve: false,
    label: "Google Chrome on macOS",
    origin: shown,
  });
  expect(
    getByText("Nothing was connected. You can close this tab."),
  ).toBeTruthy();
});

test("Connect sends the origin the page shows", async () => {
  const shown = "http://[::1]:7470";
  pendingAnswer = { ok: true, pending: { origin: shown, via: "desktop" } };
  const { findByRole, findByText } = render(<ConnectPage />);
  await findByText(shown);
  fireEvent.click(await findByRole("button", { name: "Connect" }));
  await findByText(
    "Connected as Google Chrome on macOS. You can close this tab.",
  );
  expect(received.at(-1)).toEqual({
    type: "page.connect.decide",
    approve: true,
    label: "Google Chrome on macOS",
    origin: shown,
  });
});

test("a failed pending lookup shows the real error, not the no-connection sentence", async () => {
  pendingAnswer = { ok: false, error: "x" };
  const { findByRole, queryByText } = render(<ConnectPage />);
  expect((await findByRole("alert")).textContent).toBe("x");
  expect(queryByText(/No connection is waiting/)).toBeNull();
});

test("no pending connection still shows the no-connection sentence", async () => {
  pendingAnswer = { ok: true, pending: null };
  const { findByText } = render(<ConnectPage />);
  await findByText(/No connection is waiting/);
});

test("the browser name input is capped at 80 characters", async () => {
  const { findByText, findByLabelText } = render(<ConnectPage />);
  const user = userEvent.setup({ document });
  await user.click((await findByText("Name")).closest("button") as HTMLElement);
  const input = (await findByLabelText(
    "Name this browser",
  )) as HTMLInputElement;
  expect(input.maxLength).toBe(80);
});
