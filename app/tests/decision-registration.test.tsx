import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { z } from "zod";
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
    context?: { signal?: AbortSignal; toolCall?: { id?: string } },
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
  // Never hidden by the grants of the Bot on screen: each run is offered its own Bot's (bot-offer.ts).
  expect(last).toBeDefined();
  expect((last as Registered).available).toBeUndefined();
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

/*
 * EACH CALL ANSWERED FROM ITS OWN CARD. A decision is registered once for the whole app, and it is
 * offered to every run that holds it, on screen or not, so two can wait at once. It used to keep one
 * answer slot: the second call took it, the first never heard back, and the answer on one card went
 * to whichever call had asked last.
 */
const keyedAnswers = new Map<string, (result: unknown) => Promise<void>>();
function KeyedDecision(props: {
  toolCallId?: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  if (props.toolCallId && props.respond)
    keyedAnswers.set(props.toolCallId, props.respond);
  return <p>decision {props.toolCallId}</p>;
}

test("two decisions waiting at once are each answered from their own card", async () => {
  keyedAnswers.clear();
  const registered: Registered[] = [];
  const store = createGrantStore();
  const held = new Map([["askApproval", "d"]]);
  store.set({ grants: { status: "known", held } });
  renderHook(() =>
    useDecisionTool(
      { ...spec, Component: KeyedDecision },
      store,
      held,
      (tool) => {
        registered.push(tool as Registered);
      },
    ),
  );
  const tool = registered.at(-1) as Registered;
  const Render = tool.render as (
    props: Record<string, unknown>,
  ) => React.ReactNode;

  const first = tool.handler({}, { toolCall: { id: "call-a" } });
  const second = tool.handler({}, { toolCall: { id: "call-b" } });
  render(
    <>
      <Render args={{}} status="executing" toolCallId="call-a" />
      <Render args={{}} status="executing" toolCallId="call-b" />
    </>,
  );
  const settled = (waiting: Promise<unknown>) =>
    Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 100)),
    ]);

  await act(async () => {
    await keyedAnswers.get("call-a")?.("approved");
  });
  expect(await settled(first)).toBe("approved");
  expect(await settled(second)).toBe("still waiting");

  await act(async () => {
    await keyedAnswers.get("call-b")?.("declined");
  });
  expect(await settled(second)).toBe("declined");
});

/*
 * REGISTERED IS NOT ENOUGH: IT HAS TO BE IN THE LIST A RUN IS SENT. `buildFrontendTools` leaves out
 * a tool whose `available` is false or "disabled", and the offer for each Bot is decided after it.
 */
test("a decision is in the tool list a run is sent", () => {
  let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;
  function Capture() {
    core = useCopilotKit().copilotkit;
    return null;
  }
  function Registers() {
    useDecisionTool(
      { ...spec, parameters: z.object({ question: z.string() }) },
      createGrantStore(),
      new Map(),
    );
    return null;
  }
  render(
    <CopilotKitProvider>
      <Registers />
      <Capture />
    </CopilotKitProvider>,
  );

  // The list a run is sent: the SDK builds it with this, privately, for every run it starts.
  const offered = (
    core as unknown as { buildFrontendTools(): { name: string }[] }
  ).buildFrontendTools();
  expect(offered.map((entry) => entry.name)).toContain("askApproval");
});
