import {
  OpenGenerativeUIActivityRenderer,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import {
  answeredTooEarly,
  drawnTooEarlyAnswer,
} from "@openbot/shared/tool-steps";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import * as z from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { RefusedCard } from "@/components/gallery/refused";
import {
  agentComponentsQueryOptions,
  decideComponent,
  type GrantedComponent,
} from "@/lib/components/queries";
import {
  type ToolCallContext,
  useBotOfCall,
  useDeclaredBotId,
} from "@/lib/copilot/active-bot";
import { heldComponent, useOfferedTo } from "@/lib/copilot/bot-offer";
import { drawnTooEarlyIn } from "@/lib/copilot/tool-steps";
import {
  type PublishedSandboxed,
  publishedSandboxedQueryOptions,
} from "@/lib/sandboxed/queries";

/**
 * Browser-authored components use the same component grants as compiled gallery components, but
 * render published runtime markup in the SDK sandbox.
 */
export function SandboxedTools() {
  // The grants of the Bot on screen, for the cards drawn in its conversation. Fetched only once a
  // surface has declared its Bot; the placeholder is not one the server knows, and asking would 404
  // on every poll.
  const declared = useDeclaredBotId();
  const { data: published } = useQuery(publishedSandboxedQueryOptions());
  const { data: granted } = useQuery(agentComponentsQueryOptions(declared));
  // Each one offered to the run of a Bot holding it, never by what the screen shows; see
  // `bot-offer.ts`.
  const offered = useMemo(
    () =>
      Object.fromEntries(
        (published ?? []).map((component) => [component.name, heldComponent]),
      ),
    [published],
  );
  useOfferedTo(offered);

  const held = new Map(
    (granted ?? []).map((component: GrantedComponent) => [
      component.name,
      component.description,
    ]),
  );

  return (
    <>
      {(published ?? []).map((component) => (
        <SandboxedTool
          component={component}
          description={held.get(component.name)}
          key={component.name}
        />
      ))}
    </>
  );
}

/** Convert an author's JSON Schema to SDK parameters; unreadable schemas fall back to catchall. */
function parametersFor(schema: Record<string, unknown>) {
  try {
    const converted = z.fromJSONSchema(schema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {
    // Unreadable author schemas fall back to permissive arguments and server-side checks.
  }
  return z.object({}).catchall(z.unknown());
}

function SandboxedTool({
  component,
  description,
}: {
  component: PublishedSandboxed;
  description: string | undefined;
}) {
  const [refusals, setRefusals] = useState<Map<string, string>>(new Map());
  const isHeld = description !== undefined;
  const botOf = useBotOfCall();

  const render = useCallback(
    // `toolCallId`, not `toolCall.id`: a renderer's props carry the id flat,
    // which is the shape gallery-tools and computer-tools already read and
    // the one the library's own DefaultToolCallRenderer destructures. The
    // handler below is the other shape, `context.toolCall.id`, and reading
    // that one here meant the key was always undefined -- so a refusal the
    // server had just recorded was never found, and the component the server
    // refused was drawn instead of the card saying it was not allowed.
    (props: {
      args?: Record<string, unknown>;
      result?: string;
      status?: string;
      toolCallId?: string;
    }) => {
      // Asked for too early, so never drawn. See `shared/tool-steps.ts`.
      if (answeredTooEarly(props.result)) return null;
      const refusal = props.toolCallId
        ? refusals.get(props.toolCallId)
        : undefined;
      if (refusal) {
        return <RefusedCard reason={refusal} title={component.name} />;
      }
      if (!isHeld) {
        return (
          <RefusedCard
            reason={`${component.name} is not available to this Bot at the moment. An administrator grants components per Bot.`}
            title={component.name}
          />
        );
      }

      // Wait for complete arguments because sandbox source is injected once per keyed instance.
      if (props.status !== "complete") {
        return <ToolLine label="Drawing" detail={component.name} running />;
      }

      return (
        <div className="my-2">
          <OpenGenerativeUIActivityRenderer
            activityType="open-generative-ui"
            agent={null}
            content={{
              css: component.css,
              cssComplete: true,
              html: [component.html],
              htmlComplete: true,
              jsFunctions: `window.__args = ${JSON.stringify(props.args ?? {})};\n${component.jsFunctions}`,
              jsFunctionsComplete: true,
              generating: false,
            }}
            key={JSON.stringify(props.args ?? {})}
            message={null}
          />
        </div>
      );
    },
    [component, isHeld, refusals],
  );

  useFrontendTool({
    name: component.name,
    description:
      description ??
      `A component authored in this deployment: ${component.name}.`,
    parameters: parametersFor(component.argumentSchema),
    handler: async (_args: unknown, context: ToolCallContext = {}) => {
      // Asked for in the same step as another kind of call: not drawn. See `shared/tool-steps.ts`.
      if (drawnTooEarlyIn(context?.agent?.messages, context?.toolCall?.id))
        return drawnTooEarlyAnswer(component.name);
      // The Bot that drew it, not the one on screen; see `botOfCall`.
      const decision = await decideComponent(
        component.name,
        botOf(context?.agent),
      );
      if (!decision.allowed) {
        const reason = decision.reason ?? "That component is not allowed here.";
        const id = context?.toolCall?.id;
        if (id) setRefusals((current) => new Map(current).set(id, reason));
        return reason;
      }
      return "It is now on screen for the person.";
    },
    render,
  });

  return null;
}
