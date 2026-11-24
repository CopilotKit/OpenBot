import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { canChoose } from "@/lib/models/connections";
import { type ModelPick, requestFor, shownPick } from "@/lib/models/effort";
import type { CatalogueConnection, ModelCatalogue } from "@/lib/models/queries";
import { useDraftModel } from "@/lib/models/run-model";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));
const { ModelPicker } = await import(
  "@/components/channels/composer/model-picker"
);

/*
 * The composer's picker with several AI connections (plans/multiple-ai-connections-spec.md, step
 * 3): a providers rail down the left, one button per connection, the default first; the list shows
 * the chosen one's models and opens on the one in use; a search looks through all of them, each
 * under its name; and a pick names its connection. With one connection it is the picker it was.
 */

const SOL = { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", vendor: "openai" };
const OPUS = {
  id: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  vendor: "anthropic",
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
};
const SONNET = {
  id: "claude-sonnet-5-5",
  label: "Claude Sonnet 5.5",
  vendor: "anthropic",
};

function connection(
  overrides: Partial<CatalogueConnection> &
    Pick<CatalogueConnection, "id" | "provider">,
): CatalogueConnection {
  return {
    owner: "personal",
    login: "plan",
    source: "chatgpt",
    isDefault: false,
    ready: true,
    problem: null,
    default: SOL.id,
    models: [SOL],
    listed: true,
    ...overrides,
  };
}

const CHATGPT = connection({
  id: "openai",
  provider: "openai",
  isDefault: true,
});
const CLAUDE = connection({
  id: "anthropic",
  provider: "anthropic",
  source: "claude",
  default: OPUS.id,
  models: [OPUS, SONNET],
});

function catalogueOf(connections: CatalogueConnection[]): ModelCatalogue {
  const fallback = connections.find((one) => one.isDefault) ?? connections[0];
  return {
    provider: "openai",
    source: "chatgpt",
    exposure: "all",
    default: fallback?.default ?? SOL.id,
    models: fallback?.models ?? [SOL],
    choosable: true,
    connections,
  };
}

const TWO = catalogueOf([CLAUDE, CHATGPT]);

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

async function open(view: ReturnType<typeof render>, name: string | RegExp) {
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("combobox", { name }));
  return { user, popup: await view.findByRole("dialog") };
}

/** The rail's buttons, in order. */
function rail(popup: HTMLElement) {
  return within(within(popup).getByRole("group", { name: "Providers" }))
    .getAllByRole("button")
    .map((button) => ({
      name: button.getAttribute("aria-label"),
      shown: button.getAttribute("aria-pressed"),
      button,
    }));
}

/** Show the models of the rail's button named `name`. */
async function showProvider(
  user: ReturnType<typeof userEvent.setup>,
  popup: HTMLElement,
  name: RegExp,
) {
  const button = rail(popup).find((one) => name.test(one.name ?? ""));
  if (!button) throw new Error(`No rail button ${name}`);
  await user.click(button.button);
}

test("one connection: the picker is as before and the pick is sent without a connection", async () => {
  const one = catalogueOf([{ ...CLAUDE, isDefault: true }]);
  const view = render(
    <ModelPicker
      catalogue={one}
      onChange={() => {}}
      value={{ model: SONNET.id, effort: null }}
    />,
  );
  const { popup } = await open(view, "Model: Claude Sonnet 5.5");
  expect(within(popup).queryByText("Claude plan")).toBeNull();
  const saved = requestFor(
    { model: SONNET.id, effort: null, connection: "anthropic" },
    one,
  );
  expect(saved).toEqual({ model: SONNET.id, effort: null });
});

test("two connections: a rail with each one, the default first, opening on the one in use", async () => {
  const view = render(
    <ModelPicker
      catalogue={TWO}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const { user, popup } = await open(view, "Model: GPT-6.2 Sol");
  expect(rail(popup).map(({ name, shown }) => [name, shown])).toEqual([
    ["ChatGPT plan", "true"],
    ["Claude plan", "false"],
  ]);
  const names = () =>
    within(popup)
      .getAllByRole("option")
      .map((option) => option.textContent);
  expect(names().some((name) => name?.includes("GPT-6.2 Sol"))).toBe(true);
  expect(names().some((name) => name?.includes("Claude"))).toBe(false);
  // The rail says whose models these are: no heading over them.
  expect(within(popup).queryByText("ChatGPT plan")).toBeNull();
  await showProvider(user, popup, /^Claude plan/);
  expect(rail(popup).map(({ shown }) => shown)).toEqual(["false", "true"]);
  expect(names().some((name) => name?.includes("Claude Opus 5.5"))).toBe(true);
  expect(names().some((name) => name?.includes("GPT-6.2 Sol"))).toBe(false);
});

test("one connection draws no rail", async () => {
  const one = catalogueOf([{ ...CLAUDE, isDefault: true }]);
  const view = render(
    <ModelPicker
      catalogue={one}
      onChange={() => {}}
      value={{ model: SONNET.id, effort: null }}
    />,
  );
  const { popup } = await open(view, "Model: Claude Sonnet 5.5");
  expect(within(popup).queryByRole("group", { name: "Providers" })).toBeNull();
});

test("the same model id under two connections saves the connection picked, and only that one reads as picked", async () => {
  const gateway = connection({
    id: "openai-compatible",
    provider: "openai-compatible",
    login: "endpoint",
    source: "gateway",
  });
  const key = connection({
    id: "openai-key",
    provider: "openai",
    login: "api-key",
    source: "openai",
    isDefault: true,
  });
  const picks: unknown[] = [];
  const view = render(
    <ModelPicker
      catalogue={catalogueOf([key, gateway])}
      onChange={(pick) => picks.push(pick)}
      value={{ model: SOL.id, effort: null, connection: "openai-compatible" }}
    />,
  );
  const { user, popup } = await open(view, "Model: GPT-6.2 Sol");
  // Opened on the connection in use: its Sol is the one picked.
  const inUse = within(popup).getAllByRole("option", { name: /GPT-6.2 Sol/ });
  expect(inUse.map((option) => option.getAttribute("aria-selected"))).toEqual([
    "true",
  ]);
  // The other connection's Sol is another model, not picked.
  const keyButton = rail(popup)[0];
  await user.click(keyButton?.button as HTMLElement);
  const other = within(popup).getAllByRole("option", { name: /GPT-6.2 Sol/ });
  expect(other.map((option) => option.getAttribute("aria-selected"))).toEqual([
    "false",
  ]);
  await user.click(other[0] as HTMLElement);
  expect(picks).toEqual([
    { model: SOL.id, effort: null, connection: "openai-key" },
  ]);
});

test("a stopped connection's group shows its sentence and offers no model", async () => {
  const sentence = "Your Claude plan sign-in ended. Sign in again to use it.";
  const stopped = {
    ...CLAUDE,
    ready: false,
    problem: { code: "sign-in-ended", detail: sentence },
  };
  const view = render(
    <ModelPicker
      catalogue={catalogueOf([CHATGPT, stopped])}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const { user, popup } = await open(view, "Model: GPT-6.2 Sol");
  // Marked on the rail, and named as one that can't run.
  expect(rail(popup)[1]?.name).toBe("Claude plan, can't run now");
  await showProvider(user, popup, /^Claude plan/);
  expect(within(popup).getByText(sentence)).toBeTruthy();
  expect(within(popup).queryByRole("option", { name: /Claude/ })).toBeNull();
});

test("the default connection can't be read: the picker stays, and offers the others", async () => {
  const sentence = "Your ChatGPT plan sign-in ended. Sign in again to use it.";
  // The catalogue's own fields describe the default, which lists nothing while it is stopped.
  const defaultStopped: ModelCatalogue = {
    ...catalogueOf([
      {
        ...CHATGPT,
        ready: false,
        models: [],
        problem: { code: "sign-in-ended", detail: sentence },
      },
      CLAUDE,
    ]),
    models: [],
    choosable: false,
  };
  expect(canChoose(defaultStopped)).toBe(true);
  const picks: ModelPick[] = [];
  const view = render(
    <ModelPicker
      catalogue={defaultStopped}
      onChange={(pick) => picks.push(pick)}
      stopped
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const { user, popup } = await open(view, /^Model: gpt-6.2-sol/);
  expect(within(popup).getByText(sentence)).toBeTruthy();
  await showProvider(user, popup, /^Claude plan/);
  await user.click(within(popup).getByRole("option", { name: /Sonnet/ }));
  expect(picks[0]).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });

  // No default at all: the same, the trigger asking to choose.
  cleanup();
  const noDefault: ModelCatalogue = {
    ...catalogueOf([{ ...CHATGPT, isDefault: false }, CLAUDE]),
    choosable: false,
  };
  const none = render(
    <ModelPicker
      catalogue={noDefault}
      onChange={() => {}}
      value={shownPick({ model: null, effort: null }, noDefault)}
    />,
  );
  expect(none.getByRole("combobox", { name: /Choose a model/ })).toBeTruthy();

  // One connection that can't be chosen from is still no picker, as before.
  cleanup();
  const one = { ...catalogueOf([CHATGPT]), choosable: false };
  expect(canChoose(one)).toBe(false);
  const single = render(
    <ModelPicker
      catalogue={one}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null }}
    />,
  );
  expect(single.queryByRole("combobox")).toBeNull();
});

test("a pick whose connection left the catalogue shows the default and sends nothing", () => {
  const onlyChatGpt = catalogueOf([
    CHATGPT,
    connection({ id: "xai", provider: "xai" }),
  ]);
  const shown = shownPick(
    { model: OPUS.id, effort: "high", connection: "anthropic" },
    onlyChatGpt,
  );
  expect(shown).toEqual({ model: SOL.id, effort: null, connection: "openai" });
  // What a save would send for what is shown is the default: nothing pinned.
  expect(requestFor(shown as NonNullable<typeof shown>, onlyChatGpt)).toEqual({
    model: null,
    effort: null,
  });
});

test("a model on a connection that isn't the default is saved with its connection", () => {
  expect(
    requestFor(
      { model: OPUS.id, effort: "high", connection: "anthropic" },
      TWO,
    ),
  ).toEqual({ model: OPUS.id, effort: "high", connection: "anthropic" });
  expect(
    shownPick({ model: OPUS.id, effort: "high", connection: "anthropic" }, TWO),
  ).toEqual({ model: OPUS.id, effort: "high", connection: "anthropic" });
});

test("no default connection: the trigger asks to choose, and a pick still saves", async () => {
  const noDefault = catalogueOf([{ ...CHATGPT, isDefault: false }, CLAUDE]);
  const picks: ModelPick[] = [];
  const view = render(
    <ModelPicker
      catalogue={noDefault}
      onChange={(pick) => picks.push(pick)}
      value={shownPick({ model: null, effort: null }, noDefault)}
    />,
  );
  const { user, popup } = await open(view, /Choose a model/);
  await showProvider(user, popup, /^Claude plan/);
  await user.click(within(popup).getByRole("option", { name: /Sonnet/ }));
  expect(picks[0]).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });
  expect(requestFor(picks[0] as never, noDefault)).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });
});

test("a new conversation's pick keeps its connection on the first save", () => {
  const { result } = renderHook(() => useDraftModel(TWO), { wrapper });
  act(() =>
    result.current.choose({
      model: SONNET.id,
      effort: null,
      connection: "anthropic",
    }),
  );
  expect(result.current.requested).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });
  expect(result.current.value).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });
});

test("search looks through every connection, whichever the rail shows", async () => {
  const view = render(
    <ModelPicker
      catalogue={TWO}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const { user, popup } = await open(view, "Model: GPT-6.2 Sol");
  await user.type(
    within(popup).getByPlaceholderText("Search models"),
    "Sonnet",
  );
  expect(
    within(popup).getByRole("option", { name: /Claude Sonnet 5.5/ }),
  ).toBeTruthy();
  expect(
    within(popup).queryByRole("option", { name: /GPT-6.2 Sol/ }),
  ).toBeNull();
  expect(within(popup).queryByText("ChatGPT plan")).toBeNull();
});

test("a stopped connection of the person's own offers Reconnect in its group; the organization's doesn't", async () => {
  const stoppedOwn = {
    ...CLAUDE,
    ready: false,
    problem: { code: "sign-in-ended", detail: "Sign in again." },
  };
  const view = render(
    <ModelPicker
      catalogue={catalogueOf([CHATGPT, stoppedOwn])}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const { user, popup } = await open(view, "Model: GPT-6.2 Sol");
  await showProvider(user, popup, /^Claude plan/);
  expect(
    within(popup).getByRole("link", { name: "Reconnect" }).getAttribute("href"),
  ).toBe("/settings/providers/anthropic?owner=personal");
  cleanup();
  const theirs = render(
    <ModelPicker
      catalogue={catalogueOf([
        { ...CHATGPT, owner: "organization" },
        { ...stoppedOwn, owner: "organization" },
      ])}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const second = await open(theirs, "Model: GPT-6.2 Sol");
  await showProvider(second.user, second.popup, /^Claude plan/);
  expect(within(second.popup).getByText("Sign in again.")).toBeTruthy();
  expect(
    within(second.popup).queryByRole("link", { name: "Reconnect" }),
  ).toBeNull();
});

test("one connection and no default: the picker names it, and a pick saves with its connection", async () => {
  const alone = catalogueOf([CLAUDE]);
  const picks: ModelPick[] = [];
  const view = render(
    <ModelPicker
      catalogue={alone}
      onChange={(pick) => picks.push(pick)}
      value={shownPick({ model: null, effort: null }, alone)}
    />,
  );
  const { user, popup } = await open(view, /Choose a model/);
  expect(within(popup).getByText("Claude plan")).toBeTruthy();
  await user.click(within(popup).getByRole("option", { name: /Sonnet/ }));
  expect(picks[0]).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });
  expect(requestFor(picks[0] as ModelPick, alone)).toEqual({
    model: SONNET.id,
    effort: null,
    connection: "anthropic",
  });
});

test("a pick on a stopped connection stays on it, even when that connection lists no models", () => {
  const stopped = catalogueOf([
    CHATGPT,
    {
      ...CLAUDE,
      ready: false,
      problem: { code: "sign-in-ended", detail: "Sign in again." },
      models: [],
    },
  ]);
  const shown = shownPick(
    { model: OPUS.id, effort: "high", connection: "anthropic" },
    stopped,
  );
  expect(shown).toEqual({
    model: OPUS.id,
    effort: "high",
    connection: "anthropic",
  });
  const view = render(
    <ModelPicker
      catalogue={stopped}
      onChange={() => {}}
      stopped
      value={shown}
    />,
  );
  expect(
    view.getByRole("combobox", { name: new RegExp(`Model: ${OPUS.id}`) }),
  ).toBeTruthy();
});
