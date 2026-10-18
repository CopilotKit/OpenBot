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
import { MicrophonePage } from "../src/pages/microphone/microphone-page";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let originalMatchMedia: typeof window.matchMedia;
let stopped: number;
let getUserMediaCalls: unknown[];
let getUserMediaFails: boolean;
let permission: string;

function defineOnNavigator(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  stopped = 0;
  getUserMediaCalls = [];
  getUserMediaFails = false;
  permission = "granted";
  defineOnNavigator("mediaDevices", {
    getUserMedia: async (constraints: unknown) => {
      getUserMediaCalls.push(constraints);
      if (getUserMediaFails) throw new DOMException("no", "NotAllowedError");
      return { getTracks: () => [{ stop: () => stopped++ }] };
    },
  });
  defineOnNavigator("permissions", {
    query: async () => ({ state: permission }),
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  delete (navigator as unknown as Record<string, unknown>).permissions;
});

test("explains the lasting grant before asking", () => {
  const { getByText, getByRole } = render(<MicrophonePage />);
  expect(getByText("Allow the microphone")).toBeTruthy();
  expect(getByText(/choose Allow while visiting the site/)).toBeTruthy();
  expect(getByRole("button", { name: "Allow microphone" })).toBeTruthy();
});

test("granted: stops the tracks and says it is allowed", async () => {
  const { getByRole, findByText } = render(<MicrophonePage />);
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  expect(
    await findByText("Microphone allowed. You can close this tab."),
  ).toBeTruthy();
  expect(getUserMediaCalls).toEqual([{ audio: true }]);
  expect(stopped).toBe(1);
});

test("visit-only: a grant that reads prompt afterwards says so", async () => {
  permission = "prompt";
  const { getByRole, findByText } = render(<MicrophonePage />);
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  expect(
    await findByText(
      "Chrome allowed the microphone for this visit only. Choose Allow microphone again and pick Allow while visiting the site.",
    ),
  ).toBeTruthy();
  expect(stopped).toBe(1);
});

test("denied: names the settings page", async () => {
  getUserMediaFails = true;
  const { getByRole, findByText } = render(<MicrophonePage />);
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  expect(
    await findByText(
      "Chrome blocked the microphone. Open chrome://settings/content/microphone, allow OpenBot Recorder, then try again.",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(getByRole("button", { name: "Allow microphone" })).toBeTruthy(),
  );
});
