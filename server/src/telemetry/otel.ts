/**
 * OpenTelemetry export of the audit trail and of Bot actions, which is also the SIEM stream.
 *
 * Every row `createAuditStore` writes is emitted as an OTLP log record over HTTP, through the
 * official `@opentelemetry/sdk-logs` batch processor and `@opentelemetry/exporter-logs-otlp-http`.
 * A SIEM that speaks OTLP (or an OpenTelemetry Collector in front of Splunk, Datadog, Sentinel or
 * Elastic) receives the same events the Audit page shows, sanitised the same way, as they happen.
 *
 * Configured with the standard OpenTelemetry environment variables, read by the SDK itself:
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`
 * (for a collector's API key), `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`. Nothing set means
 * nothing is exported and nothing is loaded. `OPENBOT_OTEL_EXPORT=off` turns it off with an endpoint
 * still configured.
 *
 * Every record carries `openbot.surface`, the counterpart of Grok Bot's `cursor.surface=grok_bot`:
 * `bot` for something a Bot did (computer actions, tool calls, handoffs), `identity` for sign-in and
 * people, `control_plane` for everything an administrator or member configured.
 *
 * Never fatal. An unreachable collector drops records after the SDK's own retries, and the audit row
 * in PostgreSQL is still the record of truth.
 */
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { scrubCommand } from "./scrub";

export type ExportedEvent = {
  eventType: string;
  targetType: string;
  targetId?: string | null;
  actorUserId?: string | null;
  initiatorKind: string;
  initiatorId?: string | null;
  payload: Record<string, unknown>;
  /** Overrides the surface derived from the event type. */
  surface?: string;
};

export type EventExporter = {
  emit: (event: ExportedEvent) => void;
  shutdown: () => Promise<void>;
};

const BOT_PREFIXES = [
  "computer.",
  "mcp.call",
  "mcp.tools",
  "agent.",
  "bot.declined",
  "component.function",
  "action.",
];
const IDENTITY_PREFIXES = [
  "session.",
  "person.",
  "identity_provider.",
  "scim.",
];

export function surfaceOf(eventType: string): string {
  if (BOT_PREFIXES.some((prefix) => eventType.startsWith(prefix))) return "bot";
  if (IDENTITY_PREFIXES.some((prefix) => eventType.startsWith(prefix)))
    return "identity";
  return "control_plane";
}

function severityOf(eventType: string): SeverityNumber {
  if (
    /(refused|rejected|failed|stalled|revoked|deprovisioned|break_glass)/.test(
      eventType,
    )
  ) {
    return SeverityNumber.WARN;
  }
  return SeverityNumber.INFO;
}

/**
 * Every `command` in a payload, at any depth, scrubbed the way Action Recording scrubs it.
 *
 * The audit trail keeps the command a Bot ran in full, because a command is the action; a copy that
 * leaves the deployment for a collector must not take the credentials typed into it with it.
 */
function scrubCommands(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubCommands);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === "command" && typeof nested === "string"
        ? scrubCommand(nested)
        : scrubCommands(nested),
    ]),
  );
}

/** OTLP attributes are flat primitives; nested values go in as JSON. */
function flatten(
  payload: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    out[`openbot.payload.${key}`] =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return out;
}

/** `key1=value1,key2=value2`, percent-decoded, as the OpenTelemetry specification defines it. */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    headers[decodeURIComponent(pair.slice(0, index).trim())] =
      decodeURIComponent(pair.slice(index + 1).trim());
  }
  return headers;
}

export function otelConfigured(
  env: Record<string, string | undefined>,
): boolean {
  if (env.OPENBOT_OTEL_EXPORT?.trim().toLowerCase() === "off") return false;
  return Boolean(
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() ||
      env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim(),
  );
}

export function createOtelEventExporter(
  env: Record<string, string | undefined> = process.env,
): EventExporter | undefined {
  if (!otelConfigured(env)) return undefined;

  /*
   * The endpoint and headers are read from `env` and passed explicitly, so the configuration this
   * function was given is the one used (the SDK on its own reads only `process.env`). Same rules as
   * the SDK: the logs endpoint is used as written, the generic one gets `/v1/logs` appended.
   */
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const url =
    logsEndpoint ||
    `${(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim().replace(/\/$/, "")}/v1/logs`;
  const exporter = new OTLPLogExporter({
    url,
    headers: parseHeaders(
      env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    timeoutMillis: 10_000,
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME?.trim() || "openbot",
    }),
    processors: [new BatchLogRecordProcessor({ exporter })],
  });
  const logger = provider.getLogger("openbot.audit");

  return {
    emit(event) {
      try {
        logger.emit({
          severityNumber: severityOf(event.eventType),
          severityText:
            severityOf(event.eventType) === SeverityNumber.WARN
              ? "WARN"
              : "INFO",
          body: event.eventType,
          eventName: event.eventType,
          attributes: {
            "openbot.surface": event.surface ?? surfaceOf(event.eventType),
            "openbot.event_type": event.eventType,
            "openbot.target_type": event.targetType,
            ...(event.targetId ? { "openbot.target_id": event.targetId } : {}),
            ...(event.actorUserId
              ? { "openbot.actor_user_id": event.actorUserId }
              : {}),
            "openbot.initiator_kind": event.initiatorKind,
            ...(event.initiatorId
              ? { "openbot.initiator_id": event.initiatorId }
              : {}),
            ...flatten(scrubCommands(event.payload) as Record<string, unknown>),
          },
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "otel-export-failed",
            eventType: event.eventType,
            error: String(error),
          }),
        );
      }
    },
    shutdown: () => provider.shutdown(),
  };
}
