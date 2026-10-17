import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectPage } from "../src/pages/connect/connect-page";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const ORIGIN = "https://openbot.example.test";
let fake: ChromeFake;
let received: { type: string; approve?: boolean; label?: string }[];
let decideAnswer: unknown;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  fake = installChromeFake();
  received = [];
  decideAnswer = { ok: true };
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
      reply({ ok: true, pending: { origin: ORIGIN, via: "web" } });
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
  expect(getByText("You asked from OpenBot in this browser.")).toBeTruthy();
  expect(getByText("Google Chrome on macOS")).toBeTruthy();
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
  fake.permissions.answer = true;
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
  });
  expect(fake.permissions.requests).toEqual([{ origins: [`${ORIGIN}/*`] }]);
});

test("denied access shows the access sentence and sends no decide message", async () => {
  fake.permissions.answer = false;
  const { findByRole, findByText } = render(<ConnectPage />);
  fireEvent.click(await findByRole("button", { name: "Connect" }));
  await findByText(
    `OpenBot Recorder needs access to ${ORIGIN} to save your recordings there.`,
  );
  expect(received.map((m) => m.type)).toEqual(["page.connect.pending"]);
});

test("a refusal from OpenBot shows its sentence", async () => {
  fake.permissions.answer = true;
  decideAnswer = { ok: false, error: "That code has expired." };
  const { findByRole, findByText } = render(<ConnectPage />);
  fireEvent.click(await findByRole("button", { name: "Connect" }));
  await findByText("That code has expired.");
});

test("Cancel sends approve false", async () => {
  const { findByRole } = render(<ConnectPage />);
  fireEvent.click(await findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(received.at(-1)?.approve).toBe(false));
  expect(received.at(-1)?.type).toBe("page.connect.decide");
});
