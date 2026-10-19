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
import { SetupPage, type SetupPageDeps } from "../src/pages/setup/setup-page";

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

type Options = {
  /** What Chrome reports before any request, then after each one. */
  states?: PermissionState[];
  /** What each getUserMedia call throws (a DOMException name), or null to hand back a stream. */
  refusals?: (string | null)[];
  edge?: boolean;
};

function setup(options: Options = {}) {
  const states = [...(options.states ?? ["prompt", "granted"])];
  const refusals = [...(options.refusals ?? [null])];
  const calls: string[] = [];
  let stopped = 0;
  const deps: SetupPageDeps = {
    getUserMedia: async (constraints) => {
      calls.push(`getUserMedia ${JSON.stringify(constraints)}`);
      const refusal = refusals.length > 1 ? refusals.shift() : refusals[0];
      if (refusal) throw new DOMException("no", refusal);
      return {
        getTracks: () => [{ stop: () => stopped++ }],
      } as unknown as MediaStream;
    },
    microphoneState: async () =>
      (states.length > 1 ? states.shift() : states[0]) ?? null,
    isEdge: () => options.edge ?? false,
  };
  return {
    calls,
    stopped: () => stopped,
    ...render(<SetupPage deps={deps} />),
  };
}

test("says what happens to the words and how to answer the prompt", async () => {
  const { getByText, findByText } = setup();
  expect(getByText("Allow the microphone")).toBeTruthy();
  expect(getByText(/sends only the text to Intelligence/)).toBeTruthy();
  expect(getByText(/keeps no recording of your voice/)).toBeTruthy();
  expect(getByText(/choose Allow while visiting the site/)).toBeTruthy();
  await findByText(/^Allowed\./);
});

test("in Edge, whose prompt shows only Block and Allow, it says to choose Allow", async () => {
  const { getByText, findByText } = setup({
    states: ["prompt", "prompt"],
    edge: true,
  });
  expect(
    getByText(
      "When Edge asks, choose Allow: the Recorder listens from a page you do not see, which can use only a lasting grant.",
    ),
  ).toBeTruthy();
  await findByText(
    "Allowed for this visit only, so the Recorder could not listen while you record. Choose Allow microphone and pick Allow.",
  );
});

test("asks as soon as it opens, with no click: granted lets go of the microphone and says so", async () => {
  const { findByText, calls, stopped, queryByRole } = setup();
  expect(
    await findByText(
      "Allowed. You can close this tab and press Record in the Recorder whenever you are ready.",
    ),
  ).toBeTruthy();
  expect(calls).toEqual([`getUserMedia ${JSON.stringify({ audio: true })}`]);
  expect(stopped()).toBe(1);
  expect(queryByRole("button", { name: "Allow microphone" })).toBeNull();
});

test("already allowed: says so without opening the microphone again", async () => {
  const { findByText, calls } = setup({ states: ["granted"] });
  await findByText(/^Allowed\./);
  expect(calls).toEqual([]);
});

test("a dismissed prompt says nothing is allowed yet, and the button asks again", async () => {
  const { findByText, getByRole, calls } = setup({
    states: ["prompt", "prompt", "granted"],
    refusals: ["NotAllowedError", null],
  });
  await findByText(
    "Not allowed yet. Choose Allow microphone and answer the browser's prompt.",
  );
  fireEvent.click(getByRole("button", { name: "Allow microphone" }));
  await findByText(/^Allowed\./);
  expect(calls).toHaveLength(2);
});

test("visit-only: a grant that reads prompt afterwards says so and offers the button", async () => {
  const { findByText, getByRole } = setup({ states: ["prompt", "prompt"] });
  await findByText(
    "Allowed for this visit only, so the Recorder could not listen while you record. Choose Allow microphone and pick Allow while visiting the site.",
  );
  expect(getByRole("button", { name: "Allow microphone" })).toBeTruthy();
});

test("blocked: names the browser's own settings page, Chrome's or Edge's", async () => {
  for (const [edge, scheme] of [
    [false, "chrome"],
    [true, "edge"],
  ] as const) {
    const { findByText, getByRole, queryByText, calls, unmount } = setup({
      states: ["denied"],
      refusals: ["NotAllowedError"],
      edge,
    });
    await findByText(
      `Blocked. Open ${scheme}://settings/content/microphone, allow OpenBot Recorder, then choose Allow microphone.`,
    );
    // A blocked microphone shows no prompt, so the page does not ask on its own, nor says how to answer one.
    expect(calls).toEqual([]);
    expect(queryByText(/asks, choose Allow/)).toBeNull();
    await waitFor(() =>
      expect(
        (
          getByRole("button", {
            name: "Allow microphone",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    unmount();
  }
});

test("no microphone: says so in plain words", async () => {
  const { findByText } = setup({
    states: ["prompt", "prompt"],
    refusals: ["NotFoundError"],
  });
  await findByText(
    "No microphone was found, or another app is using it. Connect one, then choose Allow microphone.",
  );
});
