/**
 * The OpenTag pairing: OpenBot's Slack and Microsoft Teams reachability.
 *
 * OpenTag (CopilotKit's open-source Slack/Teams front on the Channels SDK) calls one AG-UI agent at
 * `AGENT_URL` with `Authorization: AGENT_AUTH_HEADER`. OpenBot is that agent: the shared secret is
 * checked in constant time, OpenTag's structured sender context names the Slack/Teams person, and the
 * person's authenticated delivery binding decides which owner, Bot and canonical thread the turn runs
 * in. Nothing in the message text or the RunAgentInput can choose an owner.
 *
 * Human-in-the-loop follows OpenTag's `confirm_write` contract (`app/interrupt.ts`,
 * `app/human-in-the-loop/confirm-write.tsx`): a CUSTOM `on_interrupt` event whose value carries
 * `__opentag_interrupt_id__` (32 lowercase hex) and `__copilotkit_interrupt_value__`
 * `{ action: "confirm_write", args }`. A card click re-runs the agent with
 * `forwardedProps.command.resume = { [interruptId]: { confirmed, always?, by } }`. The interrupt id is
 * the OpenBot approval id without dashes, and the decision still goes through the approvals service.
 *
 * Proactive messages (no Slack turn open) go the other way: OpenBot POSTs to OpenTag's
 * `/openbot/deliver`, because a managed Channel can only post inside a live delivery.
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type BindingTransport,
  type ChatTransport,
  DeliveryProviderError,
  type DeliverySender,
  type ProviderFetch,
  providerJson,
} from "./types";

export type OpenTagConfig = {
  /** Shared both ways: OpenTag sends `Bearer <secret>`, and OpenBot sends it back on deliveries. */
  secret: string;
  /** OpenTag's base URL for proactive delivery; absent means proactive Slack/Teams sends fail visibly. */
  url?: string;
  /** Optional `{seed}`/`{agentId}` template for a public PNG avatar Slack can show as the Bot's icon. */
  iconUrlTemplate?: string;
  fetch?: ProviderFetch;
};

export const OPENTAG_SENDER_CONTEXT = "openbot.sender";

function sameSecret(expected: string, presented: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Compare equal-length buffers so the check leaks neither content nor, via an early exit, length.
  const padded = Buffer.alloc(a.length);
  b.copy(padded);
  return timingSafeEqual(a, padded) && a.length === b.length;
}

export function createOpenTagTransport(config: OpenTagConfig) {
  const wire = config.fetch ?? fetch;
  const bearer = `Bearer ${config.secret}`;
  function iconUrl(sender?: DeliverySender) {
    if (!sender || !config.iconUrlTemplate) return undefined;
    return config.iconUrlTemplate
      .replaceAll(
        "{seed}",
        encodeURIComponent(sender.avatarSeed ?? sender.name),
      )
      .replaceAll("{agentId}", encodeURIComponent(sender.agentId));
  }
  return {
    config,
    /** Constant-time check of the `Authorization` header OpenTag presents. */
    authenticates(header: string | undefined | null) {
      return typeof header === "string" && sameSecret(bearer, header.trim());
    },
    /**
     * Whether a Slack user is in a channel, answered by OpenTag with the workspace's bot token
     * (`POST /openbot/membership`). Fails closed: any error or missing configuration is `false`.
     * Installed for Slack triggers with `useSlackChannelMembership`.
     */
    async isMember(input: {
      teamId: string;
      slackUserId: string;
      channelId: string;
    }): Promise<boolean> {
      if (!config.url) return false;
      try {
        const response = await wire(
          new URL("/openbot/membership", config.url),
          {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: {
              authorization: bearer,
              "content-type": "application/json",
            },
            body: JSON.stringify(input),
          },
        );
        if (!response.ok) return false;
        const body = (await response.json()) as { member?: unknown };
        return body.member === true;
      } catch {
        return false;
      }
    },
    async send(input: {
      id: string;
      address: string;
      text: string;
      transport?: BindingTransport;
      sender?: DeliverySender;
    }) {
      if (!config.url)
        throw new DeliveryProviderError(
          "OpenTag",
          "proactive_delivery_not_configured",
        );
      const platform: ChatTransport =
        input.transport === "teams" ? "teams" : "slack";
      let response: Response;
      try {
        response = await wire(new URL("/openbot/deliver", config.url), {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: bearer,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: input.id,
            platform,
            address: input.address,
            text: input.text,
            ...(input.sender
              ? {
                  sender: {
                    name: input.sender.name,
                    ...(iconUrl(input.sender)
                      ? { iconUrl: iconUrl(input.sender) }
                      : {}),
                  },
                }
              : {}),
          }),
        });
      } catch {
        throw new DeliveryProviderError("OpenTag", "network_error", true);
      }
      if (!response.ok) {
        let code = `HTTP_${response.status}`;
        try {
          const body = (await response.json()) as { error?: unknown };
          if (
            typeof body.error === "string" &&
            /^[a-z0-9_]{1,64}$/.test(body.error)
          )
            code = body.error;
        } catch {}
        throw new DeliveryProviderError(
          "OpenTag",
          code,
          response.status >= 500,
        );
      }
      const body = await providerJson("OpenTag", response);
      if (body.ok !== true || typeof body.id !== "string")
        throw new DeliveryProviderError("OpenTag", "missing_message_id", true);
      // Recorded as `<conversation>/<ts>` so a "sent" row names where it landed and can be checked
      // against the conversation's history.
      return {
        id:
          typeof body.channel === "string"
            ? `${body.channel}/${body.id}`
            : body.id,
        status: "sent" as const,
      };
    },
  };
}
export type OpenTagTransport = ReturnType<typeof createOpenTagTransport>;

/** The part of `RunAgentInput` this endpoint reads. Unknown keys (tools, state) pass untouched. */
const runInputSchema = z.object({
  threadId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
  messages: z
    .array(
      z
        .object({
          id: z.string().optional(),
          role: z.string(),
          content: z.unknown().optional(),
        })
        .passthrough(),
    )
    .max(2000)
    .default([]),
  context: z
    .array(z.object({ description: z.string(), value: z.string() }))
    .max(200)
    .default([]),
  forwardedProps: z.unknown().optional(),
  tools: z
    .array(z.object({ name: z.string() }).passthrough())
    .max(500)
    .default([]),
});
export type OpenTagRunInput = z.infer<typeof runInputSchema>;
export const parseOpenTagRunInput = (value: unknown) =>
  runInputSchema.parse(value);

/**
 * OpenTag's managed-Channel user id, `provider:tenant:actor`. The actor half is taken as the rest of
 * the string because Teams user ids (`29:…`) contain colons of their own.
 */
export function parseChannelUser(
  value: unknown,
): { transport: ChatTransport; realm: string; identity: string } | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first < 1 || second < first + 2 || second === value.length - 1)
    return null;
  const provider = value.slice(0, first);
  if (provider !== "slack" && provider !== "teams") return null;
  return {
    transport: provider,
    realm: value.slice(first + 1, second),
    identity: value.slice(second + 1),
  };
}

/** Conversation kinds only the person and the app can read: a Slack DM, a Teams personal chat. */
const PRIVATE_KINDS = new Set([
  "im",
  "dm",
  "direct",
  "direct_message",
  "personal",
]);

/** The sender OpenTag vouches for. Exactly one structured entry, or nobody. */
export function senderFromContext(input: OpenTagRunInput) {
  const entries = input.context.filter(
    (entry) => entry.description === OPENTAG_SENDER_CONTEXT,
  );
  if (entries.length !== 1) return null;
  let value: {
    user?: unknown;
    event?: unknown;
    conversation?: unknown;
    mentioned?: unknown;
    observe?: unknown;
    reaction?: unknown;
  };
  try {
    value = JSON.parse(entries[0]?.value ?? "");
  } catch {
    return null;
  }
  const person = parseChannelUser(value?.user);
  if (!person) return null;
  const conversation =
    value.conversation && typeof value.conversation === "object"
      ? (value.conversation as { id?: unknown; kind?: unknown })
      : {};
  const kind = typeof conversation.kind === "string" ? conversation.kind : "";
  const id = typeof conversation.id === "string" ? conversation.id : "";
  return {
    ...person,
    conversationId: id || undefined,
    mentioned: value.mentioned === true,
    /** Not a request: an event responsibilities may watch for. No turn runs for it. */
    observe:
      value.observe === "message" || value.observe === "reaction_added"
        ? (value.observe as "message" | "reaction_added")
        : undefined,
    reaction:
      typeof value.reaction === "string" && value.reaction.length <= 100
        ? value.reaction.replaceAll(":", "")
        : undefined,
    event:
      typeof value.event === "string" && value.event.length <= 512
        ? value.event
        : undefined,
    /**
     * Whether only this person can read what is posted back. Unknown counts as shared, so an answer
     * drawn from the owner's private conversation never lands where others can read it by default.
     */
    private:
      PRIVATE_KINDS.has(kind.toLowerCase()) ||
      (person.transport === "slack" && /^D[A-Z0-9]{8,}$/.test(id)),
  };
}

/** The newest person message, as plain text, with Slack's own `<@U…>` mention tokens removed. */
export function latestUserMessage(input: OpenTagRunInput) {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) =>
                part &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join("\n")
          : "";
    return {
      id: message.id,
      text: text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, "").trim(),
    };
  }
  return null;
}

const resumeSchema = z.object({
  confirmed: z.boolean(),
  always: z.boolean().optional(),
  by: z.string().max(512).optional(),
});
/** A card click answering one OpenBot approval, or null when this run is not a resume. */
export function resumeFromInput(input: OpenTagRunInput) {
  const props = input.forwardedProps;
  if (!props || typeof props !== "object" || !("command" in props)) return null;
  const command = (props as { command?: unknown }).command;
  if (!command || typeof command !== "object" || !("resume" in command))
    return null;
  const resume = (command as { resume?: unknown }).resume;
  if (!resume || typeof resume !== "object") return { invalid: true as const };
  const entries = Object.entries(resume);
  if (entries.length !== 1) return { invalid: true as const };
  const [interruptId, value] = entries[0] ?? [];
  const parsed = resumeSchema.safeParse(value);
  if (!interruptId || !/^[0-9a-f]{32}$/.test(interruptId) || !parsed.success)
    return { invalid: true as const };
  return {
    invalid: false as const,
    approvalId: approvalIdFromInterrupt(interruptId),
    ...parsed.data,
  };
}

export const interruptIdForApproval = (approvalId: string) =>
  approvalId.replaceAll("-", "").toLowerCase();
export const approvalIdFromInterrupt = (interruptId: string) =>
  `${interruptId.slice(0, 8)}-${interruptId.slice(8, 12)}-${interruptId.slice(12, 16)}-${interruptId.slice(16, 20)}-${interruptId.slice(20)}`;

export function confirmWriteInterrupt(input: {
  approvalId: string;
  action: string;
  approver: string;
  effect?: string;
  fields: { label: string; value: string }[];
}) {
  return {
    __opentag_interrupt_id__: interruptIdForApproval(input.approvalId),
    __copilotkit_interrupt_value__: {
      action: "confirm_write",
      args: {
        action: input.action,
        fields: input.fields,
        approver: input.approver,
        ...(input.effect &&
        ["read", "write", "destructive"].includes(input.effect)
          ? { effect: input.effect }
          : {}),
        allow_always: true,
      },
    },
  };
}

/** Approver-readable rows from an already-redacted approval preview. */
export function approvalFields(preview: unknown) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview))
    return preview === undefined
      ? []
      : [{ label: "Arguments", value: clip(JSON.stringify(preview)) }];
  return Object.entries(preview)
    .slice(0, 10)
    .map(([label, value]) => ({
      label: clip(label, 60),
      value: clip(typeof value === "string" ? value : JSON.stringify(value)),
    }));
}
function clip(value: string | undefined, max = 300) {
  const text = value ?? "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Minimal AG-UI SSE writer: `data: <event>\n\n` per event, as `@ag-ui/client`'s parser reads it. */
/** How often a quiet OpenTag stream says it is still working. See {@link agUiStream}. */
export const AG_UI_HEARTBEAT_MS = 5_000;
/** `Bun.serve`'s default idle timeout, which the heartbeat has to beat. */
export const BUN_IDLE_TIMEOUT_MS = 10_000;

export function agUiStream(
  run: (emit: (event: Record<string, unknown>) => void) => Promise<void>,
  /*
   * Under Bun's own idle limit. `Bun.serve` closes a connection that has sent nothing for 10
   * seconds, and at 20 a turn longer than that lost its stream: OpenTag read the headers and
   * RUN_STARTED, the socket closed under it, and the Slack message went unanswered.
   */
  heartbeatMs = AG_UI_HEARTBEAT_MS,
) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: Record<string, unknown>) => {
        if (!closed)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
      };
      // A long governed turn says nothing for minutes; an ignored CUSTOM event keeps proxies and the
      // runner's socket from treating the silence as a dead stream.
      const heartbeat = setInterval(
        () => emit({ type: "CUSTOM", name: "openbot.working", value: {} }),
        heartbeatMs,
      );
      heartbeat.unref?.();
      try {
        await run(emit);
      } finally {
        clearInterval(heartbeat);
        closed = true;
        controller.close();
      }
    },
  });
}

export function textEvents(messageId: string, text: string) {
  if (!text) return [];
  return [
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId },
  ];
}

/** OpenTag's chart component (`app/tools/render-chart.tsx`): native in Slack and Teams. */
export const OPENTAG_CHART_TOOL = "render_chart";
/** Our component calls carry this id prefix, so the Channel's follow-up run is recognised. */
export const COMPONENT_CALL_PREFIX = "openbot-component-";

const LABEL_MAX = 20;
/** Labels clipped to OpenTag's limit and kept unique, since categories must be. */
function labelsFor(raw: string[]): string[] {
  const seen = new Set<string>();
  return raw.map((label, index) => {
    let clipped = clip(label.trim() || `Item ${index + 1}`, LABEL_MAX);
    for (let n = 2; seen.has(clipped); n++)
      clipped = `${clip(label, LABEL_MAX - String(n).length - 1)} ${n}`;
    seen.add(clipped);
    return clipped;
  });
}

type Point = { label: string; value: number };
const isPoint = (value: unknown): value is Point =>
  !!value &&
  typeof value === "object" &&
  typeof (value as Point).label === "string" &&
  Number.isFinite((value as Point).value);

/**
 * One of OpenBot's gallery charts as OpenTag's `render_chart` arguments, or null when it is not a
 * chart or cannot be drawn within that component's limits (the reply text still carries it).
 */
export function chartForOpenTag(component: {
  name: string;
  args: Record<string, unknown>;
}): Record<string, unknown> | null {
  const { args } = component;
  const title = clip(
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim()
      : "Chart",
    50,
  );
  if (component.name === "showBarChart" || component.name === "showPieChart") {
    const points = (Array.isArray(args.points) ? args.points : [])
      .filter(isPoint)
      .slice(0, component.name === "showPieChart" ? 12 : 20);
    if (points.length === 0) return null;
    const labels = labelsFor(points.map(({ label }) => label));
    if (component.name === "showPieChart") {
      const segments = points
        .map(({ value }, index) => ({ label: labels[index], value }))
        .filter(({ value }) => value > 0);
      return segments.length
        ? { title, chart: { type: "pie", segments } }
        : null;
    }
    return {
      title,
      chart: {
        type: "bar",
        series: [
          {
            name: clip(title, LABEL_MAX),
            data: points.map(({ value }, index) => ({
              label: labels[index],
              value,
            })),
          },
        ],
        axis_config: { categories: labels },
      },
    };
  }
  if (
    component.name === "showLineChart" ||
    component.name === "showAreaChart"
  ) {
    const rawLabels = (Array.isArray(args.labels) ? args.labels : [])
      .filter((label): label is string => typeof label === "string")
      .slice(0, 20);
    if (rawLabels.length === 0) return null;
    const labels = labelsFor(rawLabels);
    const series = (Array.isArray(args.series) ? args.series : [])
      .filter(
        (entry): entry is { name: string; values: number[] } =>
          !!entry &&
          typeof entry === "object" &&
          typeof entry.name === "string" &&
          Array.isArray(entry.values),
      )
      .slice(0, 12);
    if (series.length === 0) return null;
    const names = labelsFor(series.map(({ name }) => name));
    return {
      title,
      chart: {
        type: component.name === "showAreaChart" ? "area" : "line",
        series: series.map(({ values }, index) => ({
          name: names[index],
          data: labels.map((label, at) => ({
            label,
            value: Number.isFinite(values[at]) ? Number(values[at]) : 0,
          })),
        })),
        axis_config: { categories: labels },
      },
    };
  }
  return null;
}

/** A component call for the Channel to draw, as AG-UI tool-call events. */
export function componentCallEvents(
  toolCallId: string,
  toolCallName: string,
  args: Record<string, unknown>,
) {
  return [
    { type: "TOOL_CALL_START", toolCallId, toolCallName },
    { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId },
  ];
}

/** Whether this run is only the Channel reporting that it drew our component: nothing to answer. */
export function isComponentFollowUp(input: OpenTagRunInput): boolean {
  const last = input.messages.at(-1) as
    | { role?: string; toolCallId?: unknown }
    | undefined;
  return (
    last?.role === "tool" &&
    typeof last.toolCallId === "string" &&
    last.toolCallId.startsWith(COMPONENT_CALL_PREFIX)
  );
}
