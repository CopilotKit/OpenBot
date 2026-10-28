import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConversationModel } from "@openbot/shared/conversation-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { ModelSelector } from "@/components/channels/model-selector";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
let fetchMock: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.mockRestore();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const data: ConversationModel = {
  selectable: true,
  provider: "openai",
  defaultModel: "gpt-5.5",
  selectedModel: null,
  options: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  selectionUnavailable: false,
};
function renderSelector(
  options: {
    disabled?: boolean;
    onBlockingChange?: (blocked: boolean) => void;
  } = {},
) {
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={cache}>
      <ModelSelector
        channelId="channel"
        agentId="bot"
        disabled={options.disabled ?? false}
        onBlockingChange={options.onBlockingChange ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}
function respond(model: ConversationModel = data) {
  return Response.json({ model });
}
test("initial unknown state blocks, then renders only provider options and disables during a turn", async () => {
  const blocked: boolean[] = [];
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(respond());
  const view = renderSelector({
    disabled: true,
    onBlockingChange: (value) => blocked.push(value),
  });
  await waitFor(() =>
    expect(view.getByRole("combobox").hasAttribute("disabled")).toBe(true),
  );
  expect(view.getByRole("combobox").textContent).toContain("GPT-5.5");
  expect(blocked).toContain(true);
  expect(blocked.at(-1)).toBe(false);
});
test("unsupported paths hide the selector, while metadata errors offer retry and stay blocked", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    respond({ ...data, selectable: false, options: [] }),
  );
  const hidden = renderSelector();
  await waitFor(() => expect(hidden.queryByRole("status")).toBeNull());
  expect(hidden.queryByRole("combobox")).toBeNull();
  hidden.unmount();
  fetchMock.mockRestore();
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ error: "failed" }, { status: 503 }),
  );
  const blocked: boolean[] = [];
  const view = renderSelector({
    onBlockingChange: (value) => blocked.push(value),
  });
  await waitFor(() => expect(view.getByText("Retry")).toBeTruthy());
  expect(blocked.at(-1)).toBe(true);
  fetchMock.mockResolvedValue(respond());
  fireEvent.click(view.getByText("Retry"));
  await waitFor(() => expect(view.getByRole("combobox")).toBeTruthy());
});
test("save failures preserve previous model and release the sending block", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, options?: RequestInit) =>
        options?.method === "PUT"
          ? Response.json({ error: "failed" }, { status: 503 })
          : respond(),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const blocked: boolean[] = [];
  const view = renderSelector({
    onBlockingChange: (value) => blocked.push(value),
  });
  await waitFor(() => expect(view.getByRole("combobox")).toBeTruthy());
  await act(async () => fireEvent.click(view.getByRole("combobox")));
  await waitFor(() =>
    expect(view.getByRole("option", { name: "GPT-6 Luna" })).toBeTruthy(),
  );
  await act(async () =>
    fireEvent.keyDown(view.getByRole("option", { name: "GPT-6 Luna" }), {
      key: "Enter",
    }),
  );
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("Couldn't change"),
  );
  expect(view.getByRole("combobox").textContent).toContain("GPT-5.5");
  expect(blocked.at(-1)).toBe(false);
});
test("a blocked preference preserves editor text and prevents queued submission", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  let sent = 0;
  const view = render(
    <ConversationView
      messages={[]}
      pending
      submissionBlocked
      queueWhileBusy
      onSubmit={() => {
        sent++;
      }}
    />,
  );
  const editor = view.container.querySelector(
    "[contenteditable]",
  ) as HTMLElement;
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) =>
        type === "text/plain" ? "Keep this draft" : "",
      types: ["text/plain"],
      files: [],
      items: [],
    },
  });
  await settleReactWork();
  fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);
  await settleReactWork();
  expect(sent).toBe(0);
  expect(editor.textContent).toContain("Keep this draft");
});
