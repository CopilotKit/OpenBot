import { expect, test } from "bun:test";
import { partLabel } from "@/lib/desktop/part-names";
import { partLabel as statusWindowLabel } from "../../desktop/src/partNames";

/**
 * The name a person reads for each container This computer and the desktop app's Status window
 * list. Real names, as Compose and k3d give them on an installation, mapped to the part of OpenBot
 * each is. The two screens keep a copy each, so both are held to this one table.
 */
const NAMES: [string, "bots" | "back-end", string][] = [
  ["openbot-desktop-server-1", "bots", "App and Bots"],
  ["openbot-desktop-worker-1", "bots", "Background jobs"],
  ["openbot-desktop-postgres-1", "bots", "Database"],
  ["openbot-desktop-migrate-1", "bots", "Database setup"],
  ["openbot-desktop-agent-computer-1", "bots", "Bot computer"],
  // An earlier team install: its project was `openbot`, with a supervisor and a computer per Bot.
  ["openbot-postgres-1", "bots", "Database"],
  ["openbot-supervisor-1", "bots", "Bot computer manager"],
  ["openbot-computer-person-me", "bots", "Bot computer"],
  ["openbot-agent-langgraph-1", "bots", "Bot"],
  ["openbot-spire-server-1", "bots", "Bot computer identity"],
  // The local Intelligence, as `docker ps` lists a running one: its one node and k3d's tools.
  [
    "k3d-local-e0cf90debea88453ad454b93-server-0",
    "back-end",
    "Conversations and learning",
  ],
  ["k3d-local-e0cf90debea88453ad454b93-tools", "back-end", "Setup helper"],
];

/** Containers the table doesn't know: the card each is listed under says which side it's on. */
const UNKNOWN: [string, "bots" | "back-end", string][] = [
  ["something-new-1", "bots", "OpenBot service"],
  ["k3d-local-abc123-serverlb", "back-end", "OpenBot service"],
];

test.each([...NAMES, ...UNKNOWN])(
  "%s under %s reads %s",
  (name, group, label) => {
    expect(partLabel(name, group)).toBe(label);
    expect(statusWindowLabel(name, group)).toBe(label);
  },
);

test("every container OpenBot and its backend run has its own name", () => {
  const fallbacks = new Set(UNKNOWN.map(([, , label]) => label));
  for (const [name, group] of NAMES) {
    expect(fallbacks.has(partLabel(name, group))).toBe(false);
    expect(partLabel(name, group)).not.toBe("Other part");
  }
});

test("no name a person reads is Docker's or Intelligence's", () => {
  for (const [name, group] of [...NAMES, ...UNKNOWN]) {
    const label = partLabel(name, group);
    expect(label).not.toMatch(
      /openbot-|k3d|cpki|Intelligence|Other part|back[ -]?end|front[ -]?end/i,
    );
    expect(label).not.toBe(name);
  }
});
