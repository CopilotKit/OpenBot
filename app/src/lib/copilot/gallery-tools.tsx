import { useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RefusedCard } from "@/components/gallery/refused";
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
import { NOT_SHOWN, NOT_SHOWN_TAIL } from "@openbot/shared/component-markers";
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
    // A number, link or colour still arriving is held back; see `settledArgs`.
    return (
      <Component
        {...settledArgs(props.args ?? {}, props.status === "complete")}
      />
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
  const description = held.get(spec.name);
  const isHeld = description !== undefined;
  // Created once, for the same reason as `makeGalleryRender`.
  const [Render] = useState(() => makeDecisionRender(spec, store));

  useHumanInTheLoop({
    name: spec.name,
    description: description ?? spec.description,
    parameters: spec.parameters,
    available: isHeld,
    render: Render,
  });

  return null;
}

/**
 * The card a decision draws, made once per component.
 *
 * While the grants are unknown it draws the decision without `respond`, which the decision
 * components read as "not yet": the person sees what is being asked and cannot answer it until the
 * Bot is known to be allowed to ask. Then the same card enables in place. Exported for its tests.
 */
export function makeDecisionRender(spec: GalleryComponent, store: GrantStore) {
  const Component = spec.Component;
  return function DecisionRender(props: Record<string, unknown>) {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.get,
      store.get,
    );
    const state = cardState(snapshot, spec.name, spec.title);
    if (state === "draw") return <Component {...props} />;
    if (state === "wait-for-grant") {
      return <Component {...props} respond={undefined} />;
    }
    return (
      <RefusedDecision
        {...(snapshot.grants.status === "failed"
          ? { reason: COULDNT_CHECK(spec.title) }
          : {})}
        respond={
          props.respond as ((result: unknown) => Promise<void>) | undefined
        }
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
