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
 * 3): models grouped under each connection's name, the default first, and a pick that names its
 * connection. With one connection it is the picker it was.
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

test("two connections: models are grouped under each connection's name, the default first", async () => {
  const view = render(
    <ModelPicker
      catalogue={TWO}
      onChange={() => {}}
      value={{ model: SOL.id, effort: null, connection: "openai" }}
    />,
  );
  const { popup } = await open(view, "Model: GPT-6.2 Sol");
  const text = popup.textContent ?? "";
  const order = ["ChatGPT plan", "GPT-6.2 Sol", "Claude plan", "Claude Opus"];
  const at = order.map((words) => text.indexOf(words));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
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
  const options = within(popup).getAllByRole("option", { name: /GPT-6.2 Sol/ });
  expect(options).toHaveLength(2);
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(
    ["false", "true"],
  );
  await user.click(options[0] as HTMLElement);
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
  const { popup } = await open(view, "Model: GPT-6.2 Sol");
  expect(within(popup).getByText(sentence)).toBeTruthy();
  expect(within(popup).queryByRole("option", { name: /Claude/ })).toBeNull();
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

test("search finds a model in a later group", async () => {
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
