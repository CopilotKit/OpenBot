import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import {
  useDecisionTool,
  useForgetRenderOnUnmount,
} from "@/lib/copilot/gallery-tools";
import { createGrantStore } from "@/lib/copilot/grant-store";
import { settleReactWork } from "./settle-react-work";

/**
 * A decision is registered with ONE render for its whole life. The SDK's human-in-the-loop hook
 * wraps the render in a component of its own that is rebuilt whenever the tool's description
 * changes, and the description changes from the built-in words to the published ones exactly when
 * the grants load, so the card on screen was torn down then. The decision registers through
 * `useFrontendTool` itself, with the same answer-and-wait handler the SDK hook has.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
  answer = undefined;
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Registered = {
  name: string;
  description: string;
  available: boolean;
  type?: string;
  handler: (
    args: unknown,
    context?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  render: (props: Record<string, unknown>) => React.ReactNode;
};

let answer: ((result: unknown) => Promise<void>) | undefined;

function Decision(props: { respond?: (result: unknown) => Promise<void> }) {
  answer = props.respond;
  return <p>decision</p>;
}

const spec = {
  name: "askApproval",
  title: "Approval",
  kind: "decision",
  description: "Built-in words.",
  parameters: {},
  Component: Decision,
} as unknown as GalleryComponent;

test("keeps one render while the description changes as grants load", () => {
  const registered: Registered[] = [];
  const store = createGrantStore();
  const { rerender } = renderHook(
    ({ held }: { held: Map<string, string> }) =>
      useDecisionTool(spec, store, held, (tool) => {
        registered.push(tool as Registered);
      }),
    { initialProps: { held: new Map<string, string>() } },
  );

  rerender({ held: new Map([["askApproval", "Published words."]]) });

  const first = registered[0];
  const last = registered.at(-1);
  expect(first?.description).toBe("Built-in words.");
  expect(last?.description).toBe("Published words.");
  expect(last?.available).toBe(true);
  expect(last?.type).toBe("human-in-the-loop");
  expect(registered.every((tool) => tool.render === first?.render)).toBe(true);
});

test("the handler waits for the person's answer from the card", async () => {
  const registered: Registered[] = [];
  const store = createGrantStore();
  store.set({
    grants: { status: "known", held: new Map([["askApproval", "d"]]) },
  });
  renderHook(() =>
    useDecisionTool(spec, store, new Map([["askApproval", "d"]]), (tool) => {
      registered.push(tool as Registered);
    }),
  );
  const tool = registered.at(-1) as Registered;
  const Render = tool.render as (
    props: Record<string, unknown>,
  ) => React.ReactNode;

  const waiting = tool.handler({});
  render(<Render args={{}} status="executing" />);
  await act(async () => {
    await answer?.("approved");
  });

  expect(await waiting).toBe("approved");
});

test("the card cannot answer before the call is executing", () => {
  const registered: Registered[] = [];
  const store = createGrantStore();
  store.set({
    grants: { status: "known", held: new Map([["askApproval", "d"]]) },
  });
  renderHook(() =>
    useDecisionTool(spec, store, new Map([["askApproval", "d"]]), (tool) => {
      registered.push(tool as Registered);
    }),
  );
  const Render = (registered.at(-1) as Registered).render as (
    props: Record<string, unknown>,
  ) => React.ReactNode;

  render(<Render args={{}} status="inProgress" />);

  expect(answer).toBeUndefined();
});

/*
 * The SDK's own human-in-the-loop hook removes its renderer when it unmounts; the copy here did not,
 * so a decision kept drawing from a grant store nobody updated after the gallery tools went away.
 */
test("a decision's renderer is removed when it unmounts", () => {
  const removed: string[] = [];
  const core = {
    removeHookRenderToolCall: (name: string) => {
      removed.push(name);
    },
  };
  const view = renderHook(() => useForgetRenderOnUnmount("askApproval", core));
  expect(removed).toEqual([]);

  view.unmount();

  expect(removed).toEqual(["askApproval"]);
});
