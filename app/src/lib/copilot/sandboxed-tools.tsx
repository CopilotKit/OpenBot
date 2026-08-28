import {
  OpenGenerativeUIActivityRenderer,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import * as z from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { RefusedCard } from "@/components/gallery/refused";
import {
  agentComponentsQueryOptions,
  decideComponent,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useActiveBotId, useDeclaredBotId } from "@/lib/copilot/active-bot";
import {
  type PublishedSandboxed,
  publishedSandboxedQueryOptions,
} from "@/lib/sandboxed/queries";

/**
 * Browser-authored components use the same component grants as compiled gallery components, but
 * render published runtime markup in the SDK sandbox.
 */
export function SandboxedTools() {
  const botId = useActiveBotId();
  // Grants are fetched only once a surface has declared its Bot; the placeholder is not one the
  // server knows, and asking would 404 on every poll.
  const declared = useDeclaredBotId();
  const { data: published } = useQuery(publishedSandboxedQueryOptions());
  const { data: granted } = useQuery(agentComponentsQueryOptions(declared));

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
          botId={botId}
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
  botId,
}: {
  component: PublishedSandboxed;
  description: string | undefined;
  botId: string;
}) {
  const [refusals, setRefusals] = useState<Map<string, string>>(new Map());
  const isHeld = description !== undefined;

  const render = useCallback(
    (props: {
      args?: Record<string, unknown>;
      status?: string;
      toolCall?: { id?: string };
    }) => {
      const refusal = props.toolCall?.id
        ? refusals.get(props.toolCall.id)
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
    // Keep the hook mounted and hide revoked grants from the model to preserve hook order.
    available: isHeld,
    handler: async (
      _args: unknown,
      context: { toolCall?: { id?: string } } = {},
    ) => {
      const decision = await decideComponent(component.name, botId);
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
