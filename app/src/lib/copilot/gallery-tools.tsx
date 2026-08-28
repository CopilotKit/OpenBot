import { useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  const { data: granted } = useQuery(agentComponentsQueryOptions(declared));
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
          <GrantedDecision held={held} key={spec.name} spec={spec} />
        ) : (
          <GrantedTool
            grantsFor={grantsFor}
            held={held}
            key={spec.name}
            spec={spec}
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
}: {
  grantsFor: string;
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;

  /**
   * Refusals decided by the server, keyed by the call they refused.
   *
   * Per-call keys preserve the original render for calls made before a grant was revoked.
   */
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );

  const Component = spec.Component;

  const render = useCallback(
    (props: { toolCallId?: string; args?: Record<string, unknown> }) => {
      const refusal = props.toolCallId
        ? refusals.get(props.toolCallId)
        : undefined;
      if (refusal) {
        return <RefusedCard reason={refusal} title={spec.title} />;
      }
      // Render from the polled grant snapshot so revocations show before a new call starts.
      if (!isHeld) {
        return (
          <RefusedCard
            reason={`${spec.title} is not available to this Bot at the moment. An administrator grants components per Bot, and can unpublish one for every Bot at once.`}
            title={spec.title}
          />
        );
      }
      return <Component {...(props.args ?? {})} />;
    },
    [Component, isHeld, refusals, spec.title],
  );

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
          setRefusals((current) => new Map(current).set(id, reason));
        }
        // Led with the same words the card shows, so the transcript and the card agree.
        return `Not shown: ${spec.title}. ${reason} Nothing was displayed, so tell the person that.`;
      }
      return spec.confirmation ?? "It is now on screen for the person.";
    },
    render,
  });

  return null;
}

function GrantedDecision({
  spec,
  held,
}: {
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;
  const Component = spec.Component;

  /** Stable component type so in-progress decision cards do not remount. */
  const Render = useMemo(
    () =>
      function DecisionRender(props: Record<string, unknown>) {
        if (isHeld) return <Component {...props} />;
        return (
          <RefusedDecision
            respond={
              props.respond as ((result: unknown) => Promise<void>) | undefined
            }
            title={spec.title}
          />
        );
      },
    [Component, isHeld, spec.title],
  );

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
 * A decision the Bot was not allowed to ask for.
 *
 * Decision tools suspend the run, so a refusal must also answer the tool call.
 */
function RefusedDecision({
  title,
  respond,
}: {
  title: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  const reason = `${title} is not available to this Bot at the moment, so the person was not asked. An administrator grants components per Bot, and can unpublish one for every Bot at once.`;

  useEffect(() => {
    if (!respond) return;
    void respond(reason).catch(() => {
      // The run being gone is not a failure worth reporting: there is nothing left to answer.
    });
  }, [respond, reason]);

  return <RefusedCard reason={reason} title={title} />;
}
