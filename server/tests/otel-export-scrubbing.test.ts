import { expect, test } from "bun:test";
import { createOtelEventExporter } from "../src/telemetry/otel";

/**
 * The audit trail keeps the command a Bot ran in full; what leaves for an outside collector must
 * not carry the credentials in it. Checked against a real OTLP/HTTP collector on 127.0.0.1, because
 * the bytes on the wire are the thing that has to be clean.
 */
test("a command exported to the collector is scrubbed of the secrets in it", async () => {
  const secret = "fixture-value-7f3a91c0d2";
  const received: string[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(await request.text());
      return new Response("{}");
    },
  });
  try {
    const exporter = createOtelEventExporter({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    exporter?.emit({
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: "bot-1",
      actorUserId: null,
      initiatorKind: "person",
      initiatorId: null,
      payload: {
        bot: "bot-1",
        action: "computer_run_command",
        command: `curl -H "Authorization: Bearer ${secret}" https://api.example.test`,
        nested: { command: `export API_TOKEN=${secret}` },
      },
    });
    await exporter?.shutdown();
  } finally {
    collector.stop(true);
  }
  const wire = received.join("");
  expect(wire).toContain("computer_run_command");
  expect(wire).toContain("[REDACTED]");
  expect(wire).not.toContain(secret);
});
