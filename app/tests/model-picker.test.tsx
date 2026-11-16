import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  type ConversationModel,
  type ModelCatalogue,
  modelCatalogueQueryOptions,
} from "@/lib/models/queries";
import { useConversationModel, useDraftModel } from "@/lib/models/run-model";
import { queryClient } from "@/query-client";
import {
  catalogueBody,
  catalogueView,
  modelChoiceConversation,
  problemResponse,
} from "./models-api";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));
// After the stub: a static import is hoisted and would load the real marks module first.
const { ModelPicker } = await import(
  "@/components/channels/composer/model-picker"
);

/*
 * The composer's model and thinking effort picker, and the pick a conversation keeps on the server.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, as `composer-collapse.test.tsx` explains. `fetch` is a fake of the API's
 * `GET`/`PUT .../people/me/model-choices/{conversationId}` holding one `{ model, effort }` per
 * conversation, and it refuses what the server refuses: a model the catalogue does not offer, and an
 * effort the model does not accept. So a pick the picker should never send fails here as it would
 * there.
 */

const catalogue: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "gpt-5.5",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["none", "low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    },
    // Its provider does not say which effort it uses by default.
    {
      id: "gpt-6-sol",
      label: "GPT-6 Sol",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      vendor: "openai",
      efforts: ["minimal", "low", "medium", "high"],
      defaultEffort: "medium",
    },
    // Takes no effort at all.
    { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
  ],
};

const originalFetch = globalThis.fetch;
let pendingWrite: Promise<void> | undefined;
let saved: Record<string, ConversationModel> = {};
let writes: ({ channelId: string } & ConversationModel)[] = [];
/** What the server offers now: an admin narrowing the allowlist changes it under an open tab. */
let offered: ModelCatalogue = catalogue;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      if (catalogueView(url) === "offered")
        return Response.json(catalogueBody(offered));
      const channelId = modelChoiceConversation(url.pathname);
      if (!channelId)
        return Response.json({ error: "not served" }, { status: 404 });
      if (init?.method === "PUT") {
        const { model, effort } = JSON.parse(
          String(init.body),
        ) as ConversationModel;
        writes.push({ channelId, model, effort });
        const runs = catalogue.models.find(
          (option) => option.id === (model ?? catalogue.default),
        );
        if (!runs)
          return problemResponse(
            400,
            "VALIDATION_ERROR",
            "That model isn't available. Pick another one.",
          );
        if (effort !== null && !runs.efforts?.includes(effort))
          return problemResponse(
            400,
            "VALIDATION_ERROR",
            `${runs.label} doesn't take that thinking effort.`,
          );
        await pendingWrite;
        saved[channelId] = { model, effort };
      }
      // As the server answers a pick: one no longer offered reads as the default, and is kept.
      const pick = saved[channelId] ?? { model: null, effort: null };
      return Response.json(
        pick.model && !offered.models.some((option) => option.id === pick.model)
          ? { ...pick, model: null }
          : pick,
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  saved = {};
  writes = [];
  pendingWrite = undefined;
  offered = catalogue;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

/** A conversation's composer control, wired as `channel-chat.tsx` wires it. */
function Conversation({ channelId = "conversation-a" }) {
  const run = useConversationModel(channelId, catalogue);
  return (
    <ModelPicker
      catalogue={catalogue}
      onChange={run.choose}
      saving={run.saving}
      value={run.value}
    />
  );
}

/** Draw a conversation's picker once its saved pick has loaded, and open it. */
async function openPicker(name: RegExp) {
  const view = render(<Conversation />, { wrapper });
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("combobox", { name }));
  const popup = await view.findByRole("dialog");
  return { view, user, popup };
}

/** The labelled group of efforts in the open popup, or null when the model takes none. */
function thinking(popup: HTMLElement) {
  return within(popup).queryByRole("group", { name: "Thinking" });
}

test("the trigger is a CPU icon, and names a model that takes no effort on its own", () => {
  const { getByRole } = render(
    <ModelPicker
      catalogue={catalogue}
      onChange={() => {}}
      value={{ model: "gpt-4o", effort: null }}
    />,
  );
  const trigger = getByRole("combobox", { name: "Model: GPT-4o" });
  // No name and no maker's mark in the row: the CPU icon and a chevron, named for screen readers.
  expect(trigger.textContent).toBe("");
  expect(trigger.querySelector("img")).toBeNull();
  expect(trigger.firstElementChild?.classList.contains("tabler-icon-cpu")).toBe(
    true,
  );
});

/** The open popup of a picker drawn on its own. */
async function openStandalone(view: ReturnType<typeof render>, name: string) {
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("combobox", { name }));
  return await view.findByRole("dialog");
}

test("a model whose maker has no mark vendored gets the app's plain model icon in the list, never an empty gap", async () => {
  const view = render(
    <ModelPicker
      catalogue={{
        ...catalogue,
        models: [...catalogue.models, { id: "fast", label: "fast" }],
      }}
      onChange={() => {}}
      value={{ model: "fast", effort: null }}
    />,
  );
  const popup = await openStandalone(view, "Model: fast");
  const row = within(popup).getByRole("option", { name: "fast" });
  // No brand mark is invented for it, and the app's own icon holds the place.
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector("svg.tabler-icon-cube")).not.toBeNull();
});

test("Google and xAI models carry their makers' marks in the list", async () => {
  const view = render(
    <ModelPicker
      catalogue={{
        ...catalogue,
        models: [
          ...catalogue.models,
          {
            id: "gemini-3.8-flash",
            label: "Gemini 3.8 Flash",
            vendor: "google",
          },
          { id: "grok-4.7", label: "Grok 4.7", vendor: "xai" },
        ],
      }}
      onChange={() => {}}
      value={{ model: "grok-4.7", effort: null }}
    />,
  );
  const popup = await openStandalone(view, "Model: Grok 4.7");
  for (const label of ["Grok 4.7", "Gemini 3.8 Flash"])
    expect(
      within(popup)
        .getByRole("option", { name: label })
        .querySelector("img")
        ?.getAttribute("data-mark"),
    ).toBe(label);
});

test("the trigger names the chosen effort beside the model", () => {
  const { getByRole } = render(
    <ModelPicker
      catalogue={catalogue}
      onChange={() => {}}
      value={{ model: "gpt-6.1-terra", effort: "xhigh" }}
    />,
  );
  expect(
    getByRole("combobox", {
      name: "Model: GPT-6.1 Terra, thinking: Extra high",
    }),
  ).toBeTruthy();
});

test("with no effort chosen, the trigger names the model's own default", () => {
  const { getByRole } = render(
    <ModelPicker
      catalogue={catalogue}
      onChange={() => {}}
      value={{ model: "gpt-6.1-terra", effort: null }}
    />,
  );
  expect(
    getByRole("combobox", { name: "Model: GPT-6.1 Terra, thinking: Medium" }),
  ).toBeTruthy();
});

test("with no effort chosen and no default known, the trigger names the model alone", () => {
  const { getByRole } = render(
    <ModelPicker
      catalogue={catalogue}
      onChange={() => {}}
      value={{ model: "gpt-6-sol", effort: null }}
    />,
  );
  expect(getByRole("combobox", { name: "Model: GPT-6 Sol" })).toBeTruthy();
});

test("there is no picker when there is nothing to pick", () => {
  const { container } = render(
    <ModelPicker
      catalogue={{ ...catalogue, choosable: false }}
      onChange={() => {}}
      value={{ model: "gpt-5.5", effort: null }}
    />,
  );
  expect(container.innerHTML).toBe("");
});

test("there is no picker before the models have loaded", () => {
  const { container } = render(
    <ModelPicker catalogue={undefined} onChange={() => {}} value={undefined} />,
  );
  expect(container.innerHTML).toBe("");
});

test("the Default tag is the same quiet text on a model row and an effort row", async () => {
  // The model row's tag used to share the highlight's fill and vanish on the row in use.
  saved["conversation-a"] = { model: "gpt-5.5", effort: null };
  const { popup } = await openPicker(/GPT-5\.5/);
  const tags = within(popup)
    .getAllByText("Default")
    .filter((tag) => tag.closest("[role=option]")?.textContent !== "Default");
  // The default model's row, and its default effort's row.
  expect(tags).toHaveLength(2);
  const [model, effort] = tags.map((tag) => tag.className);
  expect(model).toBe(effort);
  // Muted text, which reads on the highlighted row too.
  expect(model).toContain("text-muted-foreground");
});

test("choosing an effort saves the model with it, and the trigger names it", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const { view, user, popup } = await openPicker(/GPT-6\.1 Terra/);

  const efforts = thinking(popup);
  expect(efforts).toBeTruthy();
  expect(
    within(efforts as HTMLElement)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["None", "Low", "MediumDefault", "High", "Extra high"]);
  // Nothing chosen yet, so the model's own default is the one in use.
  expect(
    within(efforts as HTMLElement)
      .getByRole("option", { name: /^Medium/ })
      .getAttribute("aria-selected"),
  ).toBe("true");

  await user.click(within(popup).getByRole("option", { name: "High" }));
  await waitFor(() =>
    expect(writes).toEqual([
      { channelId: "conversation-a", model: "gpt-6.1-terra", effort: "high" },
    ]),
  );
  expect(
    await view.findByRole("combobox", {
      name: "Model: GPT-6.1 Terra, thinking: High",
    }),
  ).toBeTruthy();
  expect(saved["conversation-a"]).toEqual({
    model: "gpt-6.1-terra",
    effort: "high",
  });
});

test("choosing the effort marked Default saves none, so the model's own default follows", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: "high" };
  const { user, popup } = await openPicker(/thinking: High/);
  await user.click(within(popup).getByRole("option", { name: /^Medium/ }));
  await waitFor(() =>
    expect(writes).toEqual([
      { channelId: "conversation-a", model: "gpt-6.1-terra", effort: null },
    ]),
  );
});

test("a model whose default effort is unknown offers Default first, and it saves none", async () => {
  saved["conversation-a"] = { model: "gpt-6-sol", effort: "high" };
  const { view, user, popup } = await openPicker(/GPT-6 Sol, thinking: High/);
  expect(
    within(thinking(popup) as HTMLElement)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Default", "Low", "Medium", "High"]);

  await user.click(within(popup).getByRole("option", { name: "Default" }));
  await waitFor(() =>
    expect(writes).toEqual([
      { channelId: "conversation-a", model: "gpt-6-sol", effort: null },
    ]),
  );
  expect(
    await view.findByRole("combobox", { name: "Model: GPT-6 Sol" }),
  ).toBeTruthy();
});

test("switching to a model that does not take the effort resets it to the model's own", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: "xhigh" };
  const { view, user, popup } = await openPicker(/Extra high/);
  await user.click(within(popup).getByRole("option", { name: "GPT-6 Sol" }));
  // Sol takes no "xhigh", so none is sent: the server would refuse it.
  await waitFor(() =>
    expect(writes).toEqual([
      { channelId: "conversation-a", model: "gpt-6-sol", effort: null },
    ]),
  );
  expect(
    await view.findByRole("combobox", { name: "Model: GPT-6 Sol" }),
  ).toBeTruthy();
  expect(saved["conversation-a"]).toEqual({ model: "gpt-6-sol", effort: null });
});

test("switching to a model that takes the effort keeps it", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: "high" };
  const { view, user, popup } = await openPicker(/thinking: High/);
  await user.click(within(popup).getByRole("option", { name: /^GPT-5\.5/ }));
  // GPT-5.5 is OpenBot's own model, so it is saved as null; the effort goes with it.
  await waitFor(() =>
    expect(writes).toEqual([
      { channelId: "conversation-a", model: null, effort: "high" },
    ]),
  );
  expect(
    await view.findByRole("combobox", {
      name: "Model: GPT-5.5, thinking: High",
    }),
  ).toBeTruthy();
});

test("a model that takes no effort shows no thinking control", async () => {
  saved["conversation-a"] = { model: "gpt-4o", effort: null };
  const { popup } = await openPicker(/^Model: GPT-4o$/);
  expect(thinking(popup)).toBeNull();
  expect(
    within(popup)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["GPT-6.1 Terra", "GPT-6 Sol", "GPT-5.5Default", "GPT-4o"]);
});

test("a search looks only for models, and the efforts stay in their column", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const { user, popup } = await openPicker(/GPT-6\.1 Terra/);
  await user.type(within(popup).getByPlaceholderText("Search models"), "sol");
  const models = () =>
    within(within(popup).getByRole("group", { name: "Models" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
  await waitFor(() => expect(models()).toEqual(["GPT-6 Sol"]));
  expect(thinking(popup)).not.toBeNull();
});

test("a search no model matches says so", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const { user, popup } = await openPicker(/GPT-6\.1 Terra/);
  await user.type(
    within(popup).getByPlaceholderText("Search models"),
    "nothing like it",
  );
  expect(await within(popup).findByText("No models match.")).toBeTruthy();
});

test("a conversation shows the pick the server holds for it", async () => {
  saved["conversation-a"] = { model: "gpt-4o", effort: null };
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() =>
    expect(result.current.value).toEqual({ model: "gpt-4o", effort: null }),
  );
});

test("a conversation with no pick shows the default", async () => {
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() =>
    expect(result.current.value).toEqual({ model: "gpt-5.5", effort: null }),
  );
});

test("picking saves to the server, and picking the default saves null", async () => {
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value?.model).toBe("gpt-5.5"));

  act(() => result.current.choose({ model: "gpt-4o", effort: null }));
  await waitFor(() => expect(result.current.saving).toBe(false));
  await waitFor(() => expect(result.current.value?.model).toBe("gpt-4o"));

  act(() => result.current.choose({ model: "gpt-5.5", effort: null }));
  await waitFor(() => expect(result.current.value?.model).toBe("gpt-5.5"));
  expect(writes).toEqual([
    { channelId: "conversation-a", model: "gpt-4o", effort: null },
    { channelId: "conversation-a", model: null, effort: null },
  ]);
});

test("a saved pick no longer offered shows as the default", async () => {
  saved["conversation-a"] = { model: "gpt-3.5-turbo", effort: "high" };
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() =>
    expect(result.current.value).toEqual({ model: "gpt-5.5", effort: "high" }),
  );
});

test("a saved effort the model does not take is not shown", async () => {
  saved["conversation-a"] = { model: "gpt-4o", effort: "high" };
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() =>
    expect(result.current.value).toEqual({ model: "gpt-4o", effort: null }),
  );
});

test("while there is nothing to pick the server is not asked", async () => {
  const { result } = renderHook(
    () =>
      useConversationModel("conversation-a", {
        ...catalogue,
        choosable: false,
      }),
    { wrapper },
  );
  expect(result.current.value).toEqual({ model: "gpt-5.5", effort: null });
  await settleReactWork();
  expect(writes).toEqual([]);
});

test("a new conversation's pick is held until it is created, and the defaults ask for nothing", () => {
  const { result } = renderHook(() => useDraftModel(catalogue));
  expect(result.current.value).toEqual({ model: "gpt-5.5", effort: null });
  expect(result.current.requested).toBeNull();

  act(() => result.current.choose({ model: "gpt-6.1-terra", effort: "high" }));
  expect(result.current.value).toEqual({
    model: "gpt-6.1-terra",
    effort: "high",
  });
  expect(result.current.requested).toEqual({
    model: "gpt-6.1-terra",
    effort: "high",
  });

  // The default model with an effort of its own still has something to save.
  act(() => result.current.choose({ model: "gpt-5.5", effort: "low" }));
  expect(result.current.requested).toEqual({ model: null, effort: "low" });

  // An effort the model does not take is dropped, never sent.
  act(() => result.current.choose({ model: "gpt-4o", effort: "low" }));
  expect(result.current.requested).toEqual({ model: "gpt-4o", effort: null });

  act(() => result.current.choose({ model: "gpt-5.5", effort: null }));
  expect(result.current.requested).toBeNull();
});

test("sending waits for the model save and refuses a failed save", async () => {
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value?.model).toBe("gpt-5.5"));

  const write = Promise.withResolvers<void>();
  pendingWrite = write.promise;
  act(() => result.current.choose({ model: "gpt-4o", effort: null }));
  let sent = false;
  const send = result.current.beforeSend().then(() => {
    sent = true;
  });
  await settleReactWork();
  expect(sent).toBe(false);
  await act(async () => {
    write.resolve();
    await send;
  });
  expect(saved["conversation-a"]).toEqual({ model: "gpt-4o", effort: null });
  expect(sent).toBe(true);

  const failed = Promise.withResolvers<void>();
  pendingWrite = failed.promise;
  act(() => result.current.choose({ model: "gpt-6-sol", effort: "high" }));
  const refused = result.current.beforeSend();
  await act(async () => {
    failed.reject(new Error("save failed"));
    await expect(refused).rejects.toThrow("save failed");
  });
  expect(saved["conversation-a"]).toEqual({ model: "gpt-4o", effort: null });
});

/**
 * A conversation's composer notice and picker, wired as `channel-chat.tsx` wires them, with the
 * catalogue read as it reads it, so the picker follows what the server offers now.
 */
function ConversationWithNotice({
  onReady,
}: {
  onReady: (beforeSend: () => Promise<void>) => void;
}) {
  const models = useQuery(modelCatalogueQueryOptions());
  const run = useConversationModel("conversation-a", models.data);
  onReady(run.beforeSend);
  return (
    <>
      {run.notice ? <p role="status">{run.notice}</p> : null}
      <ModelPicker
        catalogue={models.data}
        onChange={run.choose}
        saving={run.saving}
        value={run.value}
      />
    </>
  );
}

/*
 * A person picks GPT-6 Sol; an admin takes it off the allowlist while their tab stays open. The
 * server runs their next message on the default (the pick is kept for when Sol is allowed again),
 * and the composer has to say so, and the picker has to stop saying Sol. It used to swap silently.
 */
test("a picked model an admin stops allowing is said in the composer when the next message is sent, and the picker follows", async () => {
  saved["conversation-a"] = { model: "gpt-6-sol", effort: null };
  let beforeSend: () => Promise<void> = async () => {};
  const view = render(
    <ConversationWithNotice onReady={(send) => (beforeSend = send)} />,
    { wrapper },
  );
  await view.findByRole("combobox", { name: "Model: GPT-6 Sol" });
  expect(view.queryByRole("status")).toBeNull();

  offered = {
    ...catalogue,
    exposure: "allowed",
    models: catalogue.models.filter((model) => model.id !== "gpt-6-sol"),
  };
  await act(() => beforeSend());
  expect(view.getByRole("status").textContent).toBe(
    "GPT-6 Sol isn't allowed any more, so this conversation now uses GPT-5.5. Pick another model to change it.",
  );
  expect(
    await view.findByRole("combobox", {
      name: "Model: GPT-5.5, thinking: Medium",
    }),
  ).toBeTruthy();
  // Nothing was written: the pick stays on the server for when Sol is allowed again.
  expect(writes).toEqual([]);

  // Allowed again: the kept pick runs again, and there is nothing to say.
  offered = catalogue;
  await act(() => beforeSend());
  await view.findByRole("combobox", { name: "Model: GPT-6 Sol" });
  expect(view.queryByRole("status")).toBeNull();
});

test("a pick changed to the default somewhere else, with the model still offered, says nothing", async () => {
  saved["conversation-a"] = { model: "gpt-6-sol", effort: null };
  let beforeSend: () => Promise<void> = async () => {};
  const view = render(
    <ConversationWithNotice onReady={(send) => (beforeSend = send)} />,
    { wrapper },
  );
  await view.findByRole("combobox", { name: "Model: GPT-6 Sol" });
  // The same person picked the default in another tab.
  saved["conversation-a"] = { model: null, effort: null };
  await act(() => beforeSend());
  await view.findByRole("combobox", { name: /^Model: GPT-5\.5/ });
  expect(view.queryByRole("status")).toBeNull();

  // And picking the default here says nothing either.
  saved["conversation-a"] = { model: "gpt-6-sol", effort: null };
  await act(() => beforeSend());
  await view.findByRole("combobox", { name: "Model: GPT-6 Sol" });
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("combobox", { name: "Model: GPT-6 Sol" }));
  const popup = await view.findByRole("dialog");
  await user.click(within(popup).getByRole("option", { name: /^GPT-5\.5/ }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await act(() => beforeSend());
  expect(view.queryByRole("status")).toBeNull();
});

/**
 * The picker inside a composer, as `composer.tsx` lays it out: the message box above, the picker
 * in the controls under it.
 */
function InComposer() {
  return (
    <div data-slot="composer">
      <div data-slot="composer-input">
        {/* biome-ignore lint/a11y/useSemanticElements: the composer's message box is this. */}
        <div
          aria-label="Message"
          aria-multiline="true"
          contentEditable
          role="textbox"
          suppressContentEditableWarning
          tabIndex={0}
        />
      </div>
      <Conversation />
    </div>
  );
}

/*
 * Found on Windows by two testers: picking a model that thinks left the popup open on both
 * columns, for its efforts, and the next click, meant for the message box, landed on another
 * model in the list. Both ended up on a model they never chose. A model that takes no effort
 * closes the popup into the message box; one that does keeps it open on its efforts alone, with
 * no model left to click, and picking an effort closes it into the message box.
 */
test("picking a model that takes no effort closes the popup and puts the person back in the message box", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const view = render(<InComposer />, { wrapper });
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("combobox", { name: /GPT-6\.1 Terra/ }),
  );
  const popup = await view.findByRole("dialog");
  await user.click(within(popup).getByRole("option", { name: "GPT-4o" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  const message = view.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(document.activeElement).toBe(message));
  // The next click goes to the message box: nothing else is picked.
  await user.click(message);
  await act(async () => {});
  expect(writes).toEqual([
    { channelId: "conversation-a", model: "gpt-4o", effort: null },
  ]);
});

test("picking a model that thinks keeps the popup on its efforts alone, so no other model can be picked", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const view = render(<InComposer />, { wrapper });
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("combobox", { name: /GPT-6\.1 Terra/ }),
  );
  const popup = await view.findByRole("dialog");
  await user.click(within(popup).getByRole("option", { name: "GPT-6 Sol" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  // Still open, on GPT-6 Sol's efforts and nothing else: no model is there to be clicked.
  const open = view.getByRole("dialog");
  expect(
    within(open)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Default", "Low", "Medium", "High"]);
  expect(within(open).queryByRole("group", { name: "Models" })).toBeNull();
  // The search it keeps for the keys takes no room: kept in the popup's flow, it left a blank
  // band under the last effort (50 px on Windows F).
  const search = open.querySelector('[data-slot="input-group"]');
  expect(search?.className).toMatch(/(^|\s)absolute!(\s|$)/);
  expect(search?.className).toMatch(/(^|\s)h-0!(\s|$)/);

  // Picking an effort closes it, into the message box.
  await user.click(within(open).getByRole("option", { name: "High" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  const message = view.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(document.activeElement).toBe(message));
  await user.click(message);
  await act(async () => {});
  expect(writes).toEqual([
    { channelId: "conversation-a", model: "gpt-6-sol", effort: null },
    { channelId: "conversation-a", model: "gpt-6-sol", effort: "high" },
  ]);

  // Reopened, both columns are back.
  await user.click(view.getByRole("combobox", { name: /GPT-6 Sol/ }));
  const again = await view.findByRole("dialog");
  expect(within(again).getByRole("group", { name: "Models" })).toBeTruthy();
  expect(thinking(again)).not.toBeNull();
});

test("Esc and a click outside close the popup without picking", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const view = render(<InComposer />, { wrapper });
  const user = userEvent.setup({ document });
  const trigger = await view.findByRole("combobox", { name: /GPT-6\.1 Terra/ });
  await user.click(trigger);
  await view.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(trigger);
  await view.findByRole("dialog");
  await user.click(view.getByRole("textbox", { name: "Message" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
});

test("picking a model that takes no effort closes the popup", async () => {
  saved["conversation-a"] = { model: "gpt-6.1-terra", effort: null };
  const { view, user, popup } = await openPicker(/GPT-6\.1 Terra/);
  await user.click(within(popup).getByRole("option", { name: "GPT-4o" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});
