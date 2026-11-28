/**
 * The rows the trail holds when a limit on computers refused a new one, as `GET .../audit-events` answers them:
 * the organization's limit (one computer, for a Bot), a person's own (two), a person's own browser, and OpenBot's own
 * limit. Shared by audit-computer-limit-rows.test.tsx and the real-browser check of the same screen.
 */
export const LIMIT_BOT = "agent_notes";

function row(
  id: string,
  minute: number,
  payload: Record<string, unknown>,
  actorUserId: string | null = "ben",
) {
  return {
    id,
    actorUserId,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.limit_reached",
    targetType: "computer",
    targetId: "org/org-two/person:ben",
    payload,
    createdAt: `2026-11-19T17:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** Newest first, as the table draws them. */
export const LIMIT_ROWS = [
  row("organization", 59, {
    computer: "org/org-two/person:ben",
    person: "ben",
    bot: LIMIT_BOT,
    limit: "organization",
    cap: 1,
    count: 1,
    forPerson: "ben",
  }),
  row("person", 58, {
    computer: "org/org-two/person:ben",
    person: "ben",
    bot: LIMIT_BOT,
    limit: "person",
    cap: 2,
    count: 2,
    forPerson: "ben",
  }),
  row("browser", 57, {
    computer: "org/org-two/bot:person-0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    browser: true,
    limit: "organization",
    cap: 1,
    count: 1,
  }),
  row("deployment", 56, {
    computer: "org/org-two/person:ben",
    person: "ben",
    bot: LIMIT_BOT,
    limit: "deployment",
    cap: 8,
    count: 8,
  }),
];
