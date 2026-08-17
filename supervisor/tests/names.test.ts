import { describe, expect, test } from "bun:test";
import {
  BOT_LABEL,
  DEFAULT_NAMESPACE,
  NAMESPACE,
  NAMESPACE_LABEL,
  namesFor,
  OWNER_LABEL,
} from "../src/names";

/**
 * What a Bot id may be.
 *
 * The supervisor turns an id into a container name and two volume names, so anything it accepts it
 * can also address. These tests are the boundary: a name that escapes this file is a name the
 * supervisor will happily stop or delete.
 */
describe("the ids a supervisor will accept", () => {
  test("an ordinary agent id is accepted and its names are derived", () => {
    const result = namesFor("agent_2aaf8f2f-0e53-4bb2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.names).toEqual({
      botId: "agent_2aaf8f2f-0e53-4bb2",
      container: `${NAMESPACE}-computer-agent_2aaf8f2f-0e53-4bb2`,
      profileVolume: `${NAMESPACE}-profile-agent_2aaf8f2f-0e53-4bb2`,
      workspaceVolume: `${NAMESPACE}-workspace-agent_2aaf8f2f-0e53-4bb2`,
    });
  });

  test("a name is never taken from the caller, only derived from the id", () => {
    // The caller says which Bot. It does not get to say which container, which is what stops
    // "ensure a computer for bot X" from becoming "operate on this container of my choosing".
    const result = namesFor("sales");
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.names.container).toBe(`${NAMESPACE}-computer-sales`);
  });

  test("a slash is refused, because it would escape into another path segment", () => {
    // `/containers/{id}/stop`, an id containing a slash addresses something else entirely.
    expect(namesFor("bot/../postgres").ok).toBe(false);
    expect(namesFor("a/b").ok).toBe(false);
  });

  test("ids that could name somebody else's container are refused", () => {
    for (const id of [
      "openbot-postgres", // starts plausibly, still only ever becomes <namespace>-computer-*
      "../postgres",
      "postgres:latest", // a tag
      "bot id", // whitespace
      "bot.id", // dots invite `..` reasoning
      "-leading-hyphen",
      "",
      "   ",
    ]) {
      const result = namesFor(id);
      if (result.ok) {
        // If it is accepted it must still be confined to the supervisor's own prefix.
        expect(
          result.names.container.startsWith(`${NAMESPACE}-computer-`),
        ).toBe(true);
      } else {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
    // The specific ones that must be refused outright.
    expect(namesFor("../postgres").ok).toBe(false);
    expect(namesFor("postgres:latest").ok).toBe(false);
    expect(namesFor("bot id").ok).toBe(false);
    expect(namesFor("bot.id").ok).toBe(false);
    expect(namesFor("-leading-hyphen").ok).toBe(false);
  });

  test("a non-string is refused rather than coerced", () => {
    for (const id of [null, undefined, 42, {}, []]) {
      expect(namesFor(id).ok).toBe(false);
    }
  });

  test("an over-long id is refused", () => {
    expect(namesFor("a".repeat(65)).ok).toBe(false);
    expect(namesFor("a".repeat(64)).ok).toBe(true);
  });

  test("the ownership labels are stable", () => {
    // Stop and reset filter on these. Renaming one widens what the supervisor will act on.
    expect(OWNER_LABEL).toBe("openbot.supervisor");
    expect(BOT_LABEL).toBe("openbot.bot-id");
    expect(NAMESPACE_LABEL).toBe("openbot.namespace");
  });

  test("the default namespace is the one existing deployments already use", () => {
    // Containers created before the namespace existed carry no namespace label and are read as this
    // one, so changing it would orphan every computer a running deployment already owns.
    expect(DEFAULT_NAMESPACE).toBe("openbot");
  });
});
