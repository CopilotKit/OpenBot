import { expect, test } from "bun:test";
import { partLabel } from "@/lib/desktop/part-names";
import { partLabel as statusWindowLabel } from "../../desktop/src/partNames";

/**
 * The name a person reads for each container This computer and the desktop app's Status window
 * list. Real names, as Compose and k3d give them on an installation, mapped to the part of OpenBot
 * each is. The two screens keep a copy each, so both are held to this one table.
 */
const NAMES: [string, "bots" | "back-end", string][] = [
  ["openbot-desktop-server-1", "bots", "Front end and Bots"],
  ["openbot-desktop-worker-1", "bots", "Background jobs"],
  ["openbot-desktop-postgres-1", "bots", "Database"],
  ["openbot-desktop-migrate-1", "bots", "Database setup"],
  ["openbot-desktop-agent-computer-1", "bots", "Bot computer"],
  // An earlier team install: its project was `openbot`, with a supervisor and a computer per Bot.
  ["openbot-postgres-1", "bots", "Database"],
  ["openbot-supervisor-1", "bots", "Bot computer manager"],
  ["openbot-computer-person-me", "bots", "Bot computer"],
  ["openbot-agent-langgraph-1", "bots", "Bot"],
  ["openbot-spire-server-1", "bots", "Other part"],
  ["something-new-1", "bots", "Other part"],
  [
    "k3d-local-abc123-server-0",
    "back-end",
    "Conversations, memory and learning",
  ],
  ["k3d-local-abc123-tools", "back-end", "Other part"],
];

test.each(NAMES)("%s under %s reads %s", (name, group, label) => {
  expect(partLabel(name, group)).toBe(label);
  expect(statusWindowLabel(name, group)).toBe(label);
});

test("no name a person reads is Docker's or Intelligence's", () => {
  for (const [name, group] of NAMES) {
    const label = partLabel(name, group);
    expect(label).not.toMatch(/openbot-|k3d|cpki|Intelligence/);
    expect(label).not.toBe(name);
  }
});
