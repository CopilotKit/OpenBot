import { useCopilotKit, useFrontendTool } from "@copilotkit/react-core/v2";
import { NOT_SHOWN, NOT_SHOWN_TAIL } from "@openbot/shared/component-markers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RefusedCard } from "@/components/gallery/refused";
import {
  ArgumentsArrivingContext,
  GalleryStreamingContext,
} from "@/components/gallery/streaming";
import {
  agentComponentsQueryOptions,
  announceGallery,
  componentKeys,
  decideComponent,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useActiveBotId, useDeclaredBotId } from "@/lib/copilot/active-bot";
import {
  GALLERY_COMPONENTS,
  type GalleryComponent,
  galleryManifest,
} from "@/lib/copilot/gallery-registry";
import {
  cardState,
  COULDNT_CHECK,
  createGrantStore,
  type GrantStore,
  grantsFrom,
} from "@/lib/copilot/grant-store";
import { settledArgs } from "@/lib/copilot/settled-args";

/**
 * Register compiled gallery components once per name, scoped to the active Bot with `available`.
 * Handlers still recheck grants at call time because a run's offered tool list is only a snapshot.
 */
export function GalleryTools() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void announceGallery(galleryManifest()).then((added) => {
      if (added.length > 0) {
        void queryClient.invalidateQueries({ queryKey: componentKeys.all });
      }
    });
  }, [queryClient]);

  // Active Bot comes from the route/channel surface currently driving the provider.
  const grantsFor = useActiveBotId();
  // See sandboxed-tools: the placeholder Bot is not fetchable, so the grant query waits for a
  // surface to declare a real one.
  const declared = useDeclaredBotId();
  const grantsQuery = useQuery(agentComponentsQueryOptions(declared));
  const granted = grantsQuery.data;
  // One store per mount; every card reads its grants from here (see `grant-store.ts`).
  const [store] = useState(createGrantStore);
  useEffect(() => {
    store.set({
      grants: grantsFrom({
        data: granted,
        isError: grantsQuery.isError,
        enabled: declared !== undefined,
      }),
    });
  }, [store, granted, grantsQuery.isError, declared]);
  const held = useMemo(
    () =>
      new Map(
        (granted ?? []).map((component: GrantedComponent) => [
          component.name,
          component.description,
        ]),
      ),
    [granted],
  );

  return (
    <>
      {GALLERY_COMPONENTS.map((spec) =>
        spec.kind === "decision" ? (
          <GrantedDecision
            held={held}
            key={spec.name}
            spec={spec}
            store={store}
          />
        ) : (
          <GrantedTool
            grantsFor={grantsFor}
            held={held}
            key={spec.name}
            spec={spec}
            store={store}
          />
        ),
      )}
    </>
  );
}

function GrantedTool({
  grantsFor,
  spec,
  held,
  store,
}: {
  grantsFor: string;
  spec: GalleryComponent;
  held: Map<string, string>;
  store: GrantStore;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;
  // Created ONCE: the SDK rebuilds a card whenever this identity changes. See `makeGalleryRender`.
  const [render] = useState(() => makeGalleryRender(spec, store));

  useFrontendTool({
    name: spec.name,
    // Published descriptions are model-facing runtime behavior.
    description: description ?? spec.description,
    parameters: spec.parameters,
    // Keep the hook mounted and hide revoked grants from the model to preserve hook order.
    available: isHeld,
    handler: async (
      args: Record<string, unknown>,
      context: { toolCall?: { id?: string } },
    ) => {
      const decision = await decideComponent(
        spec.name,
        grantsFor,
        spec.reads?.(args ?? {}) ?? [],
      );
      if (!decision.allowed) {
        const reason = decision.reason ?? "That component is not allowed here.";
        const id = context?.toolCall?.id;
        if (id) {
          store.set({
            refusals: new Map(store.get().refusals).set(id, reason),
          });
        }
        // Led with the same words the card shows, so the transcript and the card agree.
        return `${NOT_SHOWN}${spec.title}. ${reason}${NOT_SHOWN_TAIL}`;
      }
      return spec.confirmation ?? "It is now on screen for the person.";
    },
    render,
  });

  return null;
}

/**
 * The card a gallery tool call draws, made once per component.
 *
 * ONCE, AND THAT IS THE POINT. The SDK hands this function to `ToolCallRenderer` as the component
 * type, and remounts the card whenever it changes identity. It used to be a `useCallback` over the
 * grants, so grants arriving (they start unknown on every channel) rebuilt every card: drawn as the
 * refusal, then torn down and drawn again as the component. Now it reads the grants from the store
 * and only re-renders. Exported for its tests.
 */
export function makeGalleryRender(spec: GalleryComponent, store: GrantStore) {
  const Component = spec.Component;
  return function GalleryRender(props: {
    toolCallId?: string;
    args?: Record<string, unknown>;
    result?: string;
    status?: string;
  }) {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.get,
      store.get,
    );
    const arriving = useContext(ArgumentsArrivingContext);
    const refusal = props.toolCallId
      ? snapshot.refusals.get(props.toolCallId)
      : undefined;
    if (refusal) {
      return <RefusedCard reason={refusal} title={spec.title} />;
    }
    /*
     * A stored refusal. The in-memory map above is gone once the page reloads, and a headless turn
     * never had one: the server answered the call itself (`server/src/components/headless.ts`).
     * The result is what survives, so a call that drew nothing is drawn as the refusal it was.
     */
    if (props.result?.startsWith(NOT_SHOWN)) {
      const lead = `${NOT_SHOWN}${spec.title}. `;
      const reason = (
        props.result.startsWith(lead)
          ? props.result.slice(lead.length)
          : props.result.slice(NOT_SHOWN.length)
      ).replace(NOT_SHOWN_TAIL, "");
      return <RefusedCard reason={reason} title={spec.title} />;
    }
    // From the polled grants, so a revocation shows before a new call starts. Unknown draws.
    const state = cardState(snapshot, spec.name, spec.title, props.toolCallId);
    if (typeof state === "object") {
      return <RefusedCard reason={state.refused} title={spec.title} />;
    }
    /*
     * A number, link or colour still arriving is held back; see `settledArgs`. Only while the
     * arguments are streaming (`inProgress`, not `executing`) in a row that can still receive them.
     */
    const complete = !(arriving && props.status === "inProgress");
    return (
      <GalleryStreamingContext.Provider value={!complete}>
        <Component {...settledArgs(props.args ?? {}, complete)} />
      </GalleryStreamingContext.Provider>
    );
  };
}

function GrantedDecision({
  spec,
  held,
  store,
}: {
  spec: GalleryComponent;
  held: Map<string, string>;
  store: GrantStore;
}) {
  useDecisionTool(spec, store, held);
  return null;
}

type FrontendTool = Parameters<typeof useFrontendTool>[0];

/**
 * The removal the SDK's `useHumanInTheLoop` does on unmount, which `useDecisionTool` copies the rest
 * of: without it a decision's renderer stayed registered after the gallery tools went away, drawing
 * from a grant store nobody updated any more.
 */
export function useForgetRenderOnUnmount(
  name: string,
  core: { removeHookRenderToolCall(name: string, agentId?: string): void },
) {
  useLayoutEffect(
    () => () => core.removeHookRenderToolCall(name),
    [core, name],
  );
}

/** `useFrontendTool`, and its renderer removed again on unmount, as `useHumanInTheLoop` does. */
function useHumanInTheLoopTool(tool: FrontendTool) {
  const { copilotkit } = useCopilotKit();
  useFrontendTool(tool);
  useForgetRenderOnUnmount(tool.name, copilotkit);
}

/**
 * A decision tool: the run waits until the person answers on the card.
 *
 * REGISTERED THROUGH `useFrontendTool`, NOT `useHumanInTheLoop`, AND THAT IS THE FIX. The SDK's
 * human-in-the-loop hook wraps the render in a component of its own that is rebuilt whenever the
 * tool's description changes (1.83.0: a `useCallback` over `tool.description`). Ours changes from
 * the built-in words to the published ones exactly when the grants load, so a decision on screen was
 * torn down at that moment, and again on a revoke. This is that hook's answer-and-wait handler, kept
 * as it is, with our render created once.
 *
 * `register` is the SDK hook (with its unmount cleanup) in the app and a recorder in the tests. Exported for its tests.
 */
export function useDecisionTool(
  spec: GalleryComponent,
  store: GrantStore,
  held: Map<string, string>,
  register: (tool: FrontendTool) => void = useHumanInTheLoopTool,
) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;
  const resolveRef = useRef<((result: unknown) => void) | null>(null);
  const stopListeningRef = useRef<(() => void) | null>(null);

  const respond = useCallback(async (result: unknown) => {
    if (!resolveRef.current) return;
    stopListeningRef.current?.();
    stopListeningRef.current = null;
    resolveRef.current(result);
    resolveRef.current = null;
  }, []);

  const handler = useCallback(
    async (_args: unknown, context?: { signal?: AbortSignal }) =>
      new Promise<unknown>((resolve, reject) => {
        const signal = context?.signal;
        if (signal?.aborted) {
          reject(new Error("Human-in-the-loop interaction aborted"));
          return;
        }
        resolveRef.current = resolve;
        if (signal) {
          const onAbort = () => {
            stopListeningRef.current = null;
            resolveRef.current = null;
            reject(new Error("Human-in-the-loop interaction aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          stopListeningRef.current = () =>
            signal.removeEventListener("abort", onAbort);
        }
      }),
    [],
  );

  // Created once, for the same reason as `makeGalleryRender`.
  const [Render] = useState(() => makeDecisionRender(spec, store, respond));

  register({
    name: spec.name,
    description: description ?? spec.description,
    parameters: spec.parameters,
    available: isHeld,
    type: "human-in-the-loop",
    handler,
    render: Render,
  } as FrontendTool);
}

/**
 * The card a decision draws, made once per component.
 *
 * It can answer only while the call is executing, as the SDK's own decisions do. While the grants
 * are unknown it draws without `respond`, which the decision components read as "not yet": the
 * person sees what is being asked and cannot answer until the Bot is known to be allowed to ask.
 * Then the same card enables in place. Exported for its tests.
 */
export function makeDecisionRender(
  spec: GalleryComponent,
  store: GrantStore,
  respond: (result: unknown) => Promise<void>,
) {
  const Component = spec.Component;
  return function DecisionRender(props: Record<string, unknown>) {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.get,
      store.get,
    );
    const answer = props.status === "executing" ? respond : undefined;
    const state = cardState(snapshot, spec.name, spec.title);
    if (state === "draw") return <Component {...props} respond={answer} />;
    if (state === "wait-for-grant") {
      return <Component {...props} respond={undefined} />;
    }
    return (
      <RefusedDecision
        {...(snapshot.grants.status === "failed"
          ? { reason: COULDNT_CHECK(spec.title) }
          : {})}
        respond={answer}
        title={spec.title}
      />
    );
  };
}

/**
 * A decision the Bot was not allowed to ask for.
 *
 * Decision tools suspend the run, so a refusal must also answer the tool call.
 */
function RefusedDecision({
  title,
  respond,
  reason = `${title} is not available to this Bot at the moment, so the person was not asked. An administrator grants components per Bot, and can unpublish one for every Bot at once.`,
}: {
  title: string;
  respond?: (result: unknown) => Promise<void>;
  reason?: string;
}) {
  useEffect(() => {
    if (!respond) return;
    void respond(reason).catch(() => {
      // The run being gone is not a failure worth reporting: there is nothing left to answer.
    });
  }, [respond, reason]);

  return <RefusedCard reason={reason} title={title} />;
}
