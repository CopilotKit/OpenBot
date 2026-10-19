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
import {
  MicrophonePage,
  type MicrophonePageDeps,
} from "../src/pages/microphone/microphone-page";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let originalMatchMedia: typeof window.matchMedia;
beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function setup(options: { refuse?: boolean; permission?: PermissionState }) {
  const calls: string[] = [];
  let stopped = 0;
  const deps: MicrophonePageDeps = {
    getUserMedia: async (constraints) => {
      calls.push(`getUserMedia ${JSON.stringify(constraints)}`);
      if (options.refuse) throw new DOMException("no", "NotAllowedError");
      return {
        getTracks: () => [{ stop: () => stopped++ }],
      } as unknown as MediaStream;
    },
    microphoneState: async () => options.permission ?? "granted",
  };
  return {
    calls,
    stopped: () => stopped,
    ...render(<MicrophonePage deps={deps} />),
  };
}

test("says what happens to the words and explains the lasting grant before asking", () => {
  const { getByText, getByRole } = setup({});
  expect(getByText("Allow the microphone")).toBeTruthy();
  expect(getByText(/sends only the text to Intelligence/)).toBeTruthy();
  expect(getByText(/keeps no recording of your voice/)).toBeTruthy();
  expect(getByText(/choose Allow while visiting the site/)).toBeTruthy();
  expect(getByRole("button", { name: "Allow microphone" })).toBeTruthy();
});

test("granted: lets go of the microphone and says it is allowed", async () => {
  const { getByRole, findByText, calls, stopped } = setup({});
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  expect(
    await findByText(
      "Microphone allowed. Go back to the tab you want to record and press Record.",
    ),
  ).toBeTruthy();
  expect(calls).toEqual([`getUserMedia ${JSON.stringify({ audio: true })}`]);
  expect(stopped()).toBe(1);
});

test("visit-only: a grant that reads prompt afterwards says so and offers the button again", async () => {
  const { getByRole, findByText } = setup({ permission: "prompt" });
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  expect(
    await findByText(
      "Chrome allowed the microphone for this visit only. Choose Allow microphone again and pick Allow while visiting the site.",
    ),
  ).toBeTruthy();
  expect(getByRole("button", { name: "Allow microphone" })).toBeTruthy();
});

test("denied: names the settings page", async () => {
  const { getByRole, findByText } = setup({ refuse: true });
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  expect(
    await findByText(
      "Chrome blocked the microphone. Open chrome://settings/content/microphone, allow OpenBot Recorder, then try again.",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      (getByRole("button", { name: "Allow microphone" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});
