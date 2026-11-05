import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import type { ModelCatalogue } from "@/lib/models/queries";
import { useConversationModel, useDraftModel } from "@/lib/models/run-model";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * The composer's model picker, and the pick a conversation keeps on the server.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, as `composer-collapse.test.tsx` explains. `fetch` is a fake server holding one pick
 * per conversation, so the hook is tested against the route it really calls.
 */

const originalFetch = globalThis.fetch;
let pendingWrite: Promise<void> | undefined;
let saved: Record<string, string | null> = {};
let writes: { channelId: string; model: unknown }[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const match = /^\/api\/channels\/([^/]+)\/model$/.exec(url.pathname);
      if (!match?.[1])
        return Response.json({ error: "not served" }, { status: 404 });
      const channelId = decodeURIComponent(match[1]);
      if (init?.method === "PUT") {
        const { model } = JSON.parse(String(init.body)) as { model: unknown };
        writes.push({ channelId, model });
        await pendingWrite;
        saved[channelId] = model as string | null;
      }
      return Response.json({ model: saved[channelId] ?? null });
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
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const catalogue: ModelCatalogue = {
  provider: "openai",
  default: "gpt-5.5",
  choosable: true,
  models: [
    { id: "gpt-6-sol", label: "GPT-6 Sol", vendor: "openai" },
    { id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" },
    { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
  ],
};

test("the picker shows the conversation's model", () => {
  const { getByRole } = render(
    <ModelPicker catalogue={catalogue} onChange={() => {}} value="gpt-4o" />,
  );
  expect(getByRole("combobox", { name: "Model: GPT-4o" })).toBeTruthy();
});

test("there is no picker when there is nothing to pick", () => {
  const { container } = render(
    <ModelPicker
      catalogue={{ ...catalogue, choosable: false }}
      onChange={() => {}}
      value="gpt-5.5"
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

test("a conversation shows the pick the server holds for it", async () => {
  saved["conversation-a"] = "gpt-4o";
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value).toBe("gpt-4o"));
});

test("a conversation with no pick shows the default", async () => {
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value).toBe("gpt-5.5"));
});

test("picking saves to the server, and picking the default saves null", async () => {
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value).toBe("gpt-5.5"));

  act(() => result.current.choose("gpt-4o"));
  await waitFor(() => expect(result.current.saving).toBe(false));
  await waitFor(() => expect(result.current.value).toBe("gpt-4o"));

  act(() => result.current.choose("gpt-5.5"));
  await waitFor(() => expect(result.current.value).toBe("gpt-5.5"));
  expect(writes).toEqual([
    { channelId: "conversation-a", model: "gpt-4o" },
    { channelId: "conversation-a", model: null },
  ]);
});

test("a saved pick no longer offered shows as the default", async () => {
  saved["conversation-a"] = "gpt-3.5-turbo";
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value).toBe("gpt-5.5"));
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
  expect(result.current.value).toBe("gpt-5.5");
  await settleReactWork();
  expect(writes).toEqual([]);
});

test("a new conversation's pick is held until it is created, and the default asks for nothing", () => {
  const { result } = renderHook(() => useDraftModel(catalogue));
  expect(result.current.value).toBe("gpt-5.5");
  expect(result.current.requested).toBeNull();

  act(() => result.current.choose("gpt-4o"));
  expect(result.current.value).toBe("gpt-4o");
  expect(result.current.requested).toBe("gpt-4o");

  act(() => result.current.choose("gpt-5.5"));
  expect(result.current.requested).toBeNull();
});

test("sending waits for the model save and refuses a failed save", async () => {
  const { result } = renderHook(
    () => useConversationModel("conversation-a", catalogue),
    { wrapper },
  );
  await waitFor(() => expect(result.current.value).toBe("gpt-5.5"));

  const write = Promise.withResolvers<void>();
  pendingWrite = write.promise;
  act(() => result.current.choose("gpt-4o"));
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
  expect(saved["conversation-a"]).toBe("gpt-4o");
  expect(sent).toBe(true);

  const failed = Promise.withResolvers<void>();
  pendingWrite = failed.promise;
  act(() => result.current.choose("gpt-6-sol"));
  const refused = result.current.beforeSend();
  await act(async () => {
    failed.reject(new Error("save failed"));
    await expect(refused).rejects.toThrow("save failed");
  });
  expect(saved["conversation-a"]).toBe("gpt-4o");
});
