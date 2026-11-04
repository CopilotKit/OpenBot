import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import type { ModelCatalogue } from "@/lib/models/queries";
import { modelChoiceKey, useConversationModel } from "@/lib/models/run-model";
import { settleReactWork } from "./settle-react-work";

/*
 * The composer's model picker and the pick a conversation remembers.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, as `composer-collapse.test.tsx` explains.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const catalogue: ModelCatalogue = {
  provider: "openai",
  default: "gpt-5.5",
  choosable: true,
  models: [
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-4o", label: "GPT-4o" },
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

test("a conversation starts on the default and asks for nothing", () => {
  const { result } = renderHook(() =>
    useConversationModel("conversation-a", catalogue),
  );
  expect(result.current.value).toBe("gpt-5.5");
  expect(result.current.requested).toBeUndefined();
});

test("a pick is remembered for that conversation only, and runs ask for it", () => {
  const { result } = renderHook(() =>
    useConversationModel("conversation-a", catalogue),
  );
  act(() => result.current.choose("gpt-4o"));
  expect(result.current.value).toBe("gpt-4o");
  expect(result.current.requested).toBe("gpt-4o");
  expect(window.localStorage.getItem(modelChoiceKey("conversation-a"))).toBe(
    "gpt-4o",
  );

  const other = renderHook(() =>
    useConversationModel("conversation-b", catalogue),
  );
  expect(other.result.current.value).toBe("gpt-5.5");
});

test("picking the default forgets the pick", () => {
  window.localStorage.setItem(modelChoiceKey("conversation-a"), "gpt-4o");
  const { result } = renderHook(() =>
    useConversationModel("conversation-a", catalogue),
  );
  act(() => result.current.choose("gpt-5.5"));
  expect(result.current.requested).toBeUndefined();
  expect(
    window.localStorage.getItem(modelChoiceKey("conversation-a")),
  ).toBeNull();
});

test("a remembered pick OpenBot no longer offers reads as the default", () => {
  window.localStorage.setItem(
    modelChoiceKey("conversation-a"),
    "gpt-3.5-turbo",
  );
  const { result } = renderHook(() =>
    useConversationModel("conversation-a", catalogue),
  );
  expect(result.current.value).toBe("gpt-5.5");
  expect(result.current.requested).toBeUndefined();
});
