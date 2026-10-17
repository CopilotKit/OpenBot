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
import { Options } from "../src/pages/options/options";
import {
  IDLE_STATE,
  type PageResponse,
  type PageStateResponse,
  type PageToBackground,
  type RecorderState,
} from "../src/protocol/messages";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

let originalMatchMedia: typeof window.matchMedia;
beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function stateResponse(
  over: Omit<Partial<PageStateResponse>, "state"> & {
    state?: Partial<RecorderState>;
  } = {},
): PageStateResponse {
  const { state, ...rest } = over;
  return {
    ok: true,
    state: { ...IDLE_STATE, ...state },
    connection: {
      openbotUrl: "https://openbot.example.test",
      user: { name: "Ada Lovelace", email: "ada@example.test" },
      via: "web",
    },
    me: null,
    policy: { openbotUrl: null, invalid: false },
    notice: null,
    ...rest,
  };
}

function setup(response: PageStateResponse) {
  const sent: PageToBackground[] = [];
  const ask = async (message: PageToBackground): Promise<PageResponse> => {
    sent.push(message);
    return message.type === "page.state" ? response : { ok: true };
  };
  const view = render(<Options deps={{ ask: ask as never }} />);
  return { sent, ...view };
}

test("shows the address, the person and how it connected", async () => {
  const { findByText, getByText } = setup(stateResponse());
  await findByText("https://openbot.example.test");
  expect(getByText("Ada Lovelace")).toBeTruthy();
  expect(getByText(/Connected from OpenBot in your browser/)).toBeTruthy();
});

test("shows the pinned address as set by the organization", async () => {
  const { findByText, getAllByText } = setup(
    stateResponse({
      policy: { openbotUrl: "https://openbot.example.test", invalid: false },
    }),
  );
  await findByText("Set by your organization");
  expect(getAllByText("https://openbot.example.test").length).toBeGreaterThan(
    0,
  );
});

test("no organization row when policy sets no address", async () => {
  const { findByText, queryByText } = setup(stateResponse());
  await findByText("Ada Lovelace");
  expect(queryByText("Set by your organization")).toBeNull();
});

test("Disconnect asks first and sends nothing on Cancel", async () => {
  const { findByRole, getByText, sent } = setup(stateResponse());
  fireEvent.click(await findByRole("button", { name: "Disconnect" }));
  expect(getByText("Disconnect this browser?")).toBeTruthy();
  expect(
    getByText("It stops recording to OpenBot until you connect it again."),
  ).toBeTruthy();
  fireEvent.click(await findByRole("button", { name: "Cancel" }));
  expect(sent.some((m) => m.type === "page.disconnect")).toBe(false);
});

test("the dialog names the kept events when some are waiting", async () => {
  const { findByRole, getByText } = setup(
    stateResponse({
      state: {
        kept: { recordings: 2, events: 40, reason: "r", parked: false },
      },
    }),
  );
  fireEvent.click(await findByRole("button", { name: "Disconnect" }));
  expect(
    getByText(
      "40 events from 2 recordings still waiting in this browser are discarded.",
    ),
  ).toBeTruthy();
});

test("confirming sends page.disconnect and shows the not-connected copy", async () => {
  const { findAllByRole, findByText, sent } = setup(stateResponse());
  fireEvent.click((await findAllByRole("button", { name: "Disconnect" }))[0]);
  const buttons = await findAllByRole("button", { name: "Disconnect" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() =>
    expect(sent.some((m) => m.type === "page.disconnect")).toBe(true),
  );
  await findByText(/This browser is not connected to OpenBot/);
});

test("a refused disconnect shows the server's sentence and stays connected", async () => {
  const ask = async (message: PageToBackground): Promise<PageResponse> =>
    message.type === "page.state"
      ? stateResponse()
      : { ok: false, error: "OpenBot did not answer." };
  const { findAllByRole, findByText } = render(
    <Options deps={{ ask: ask as never }} />,
  );
  fireEvent.click((await findAllByRole("button", { name: "Disconnect" }))[0]);
  const buttons = await findAllByRole("button", { name: "Disconnect" });
  fireEvent.click(buttons[buttons.length - 1]);
  await findByText("OpenBot did not answer.");
});

test("not connected shows the not-connected copy and no Disconnect", async () => {
  const { findByText, queryByRole } = setup(
    stateResponse({ connection: null }),
  );
  await findByText(/This browser is not connected to OpenBot/);
  expect(queryByRole("button", { name: "Disconnect" })).toBeNull();
});
