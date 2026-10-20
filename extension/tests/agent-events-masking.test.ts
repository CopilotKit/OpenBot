// The agent events leave masked and cut to fit, on real traffic: a person who hands the agent a card number and a
// password they typed earlier into a password field (so the recording holds its digest), and a person who pastes a log
// far over Intelligence's 16 KiB event limit.
import { expect, test } from "bun:test";
import {
  EVENT_BUDGET_BYTES,
  normaliseSecret,
  REDACTED,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import {
  loadFixture,
  observationsOf,
  record,
  sinkEvents,
} from "./agent-traffic";

const PASSWORD = "Tr0ub4dor-horse-77";
const CARD = /4111[ -]?1111[ -]?1111[ -]?1111/;
const digests = new Set([sha256HexSync(normaliseSecret(PASSWORD))]);

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

test("a password typed earlier and then pasted into the chat, and a card number in the chat and in a tool's arguments, never leave", async () => {
  const fixture = loadFixture("sse", "secrets");
  // CopilotKit's own events carry both as the person wrote them.
  const raw = JSON.stringify(sinkEvents(fixture.sink));
  expect(raw).toContain(PASSWORD);
  expect(raw).toMatch(CARD);

  const { emitted } = await record(observationsOf(fixture), digests);
  const out = JSON.stringify(emitted);
  expect(out).not.toContain(PASSWORD);
  expect(out).not.toMatch(CARD);

  const typed = emitted.find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { role?: string }).role === "user",
  )?.value as { text: string; textLength: number };
  const original = sinkEvents(fixture.sink).find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { role?: string }).role === "user",
  )?.value as { text: string };
  expect(typed.text).toContain(REDACTED);
  expect(typed.text).toContain("Pay invoice INV-7");
  expect(typed.textLength).toBe(original.text.length);

  const args = emitted
    .map(
      (event) =>
        (event.value as { event?: { type?: string; delta?: string } }).event,
    )
    .find((event) => event?.type === "TOOL_CALL_ARGS");
  expect(JSON.parse(args?.delta ?? "{}")).toEqual({
    invoice: "INV-7",
    cardNumber: REDACTED,
  });
});

test("without the digest of what was typed into the password field, the pasted password is ordinary text", async () => {
  const { emitted } = await record(
    observationsOf(loadFixture("sse", "secrets")),
  );
  const out = JSON.stringify(emitted);
  expect(out).toContain(PASSWORD);
  expect(out).not.toMatch(CARD);
});

test("a message over 16 KiB is cut to fit one Intelligence event, keeping its ids, its start and its full textLength", async () => {
  const fixture = loadFixture("sse", "long-message");
  const original = sinkEvents(fixture.sink).find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { role?: string }).role === "user",
  )?.value as { messageId: string; text: string };
  expect(bytes({ text: original.text })).toBeGreaterThan(16 * 1024);

  const { emitted } = await record(observationsOf(fixture));
  for (const event of emitted)
    expect(bytes(event)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  const message = emitted.find(
    (event) =>
      event.name === "agent.message" &&
      (event.value as { messageId?: string }).messageId === original.messageId,
  )?.value as { text: string; textLength: number; truncated?: boolean };
  expect(message.textLength).toBe(original.text.length);
  expect(message.text.length).toBeGreaterThan(10_000);
  expect(message.text.length).toBeLessThan(original.text.length);
  expect(original.text.startsWith(message.text)).toBe(true);
  expect(message.truncated).toBe(true);
});
