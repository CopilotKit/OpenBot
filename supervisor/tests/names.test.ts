import { describe, expect, test } from "bun:test";
import {
  BOT_LABEL,
  DEFAULT_NAMESPACE,
  KIND_LABEL,
  legacyNamesFor,
  NAMESPACE,
  NAMESPACE_LABEL,
  namesFor as namesOf,
  OWNER_LABEL,
  PERSON_LABEL,
} from "../src/names";

/** An isolated Bot's computer, which is what every id named before one computer per person. */
const namesFor = (id: unknown) => namesOf("bot", id);

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
      kind: "bot",
      id: "agent_2aaf8f2f-0e53-4bb2",
      container: `${NAMESPACE}-computer-bot-agent_2aaf8f2f-0e53-4bb2`,
      profileVolume: `${NAMESPACE}-profile-bot-agent_2aaf8f2f-0e53-4bb2`,
      workspaceVolume: `${NAMESPACE}-workspace-bot-agent_2aaf8f2f-0e53-4bb2`,
    });
  });

  test("a name is never taken from the caller, only derived from the id", () => {
    // The caller says which Bot. It does not get to say which container, which is what stops
    // "ensure a computer for bot X" from becoming "operate on this container of my choosing".
    const result = namesFor("sales");
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.names.container).toBe(`${NAMESPACE}-computer-bot-sales`);
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
    expect(KIND_LABEL).toBe("openbot.computer-kind");
    expect(PERSON_LABEL).toBe("openbot.person-id");
  });

  test("the default namespace is the one existing deployments already use", () => {
    // Containers created before the namespace existed carry no namespace label and are read as this
    // one, so changing it would orphan every computer a running deployment already owns.
    expect(DEFAULT_NAMESPACE).toBe("openbot");
  });
});

/**
 * One computer per person, and one per isolated Bot.
 *
 * The kind is in every name, so a person and a Bot never derive the same container or volumes
 * whatever their ids are: a person whose id happened to equal a Bot's would otherwise be handed that
 * Bot's logins, or the reverse.
 */
describe("whose computer a name is", () => {
  test("a person's computer and volumes are named for the person", () => {
    const result = namesOf("person", "u-ada");
    expect(result.ok && result.names).toEqual({
      kind: "person",
      id: "u-ada",
      container: `${NAMESPACE}-computer-person-u-ada`,
      profileVolume: `${NAMESPACE}-profile-person-u-ada`,
      workspaceVolume: `${NAMESPACE}-workspace-person-u-ada`,
    });
  });

  test("two people get two computers", () => {
    const ada = namesOf("person", "ada");
    const bo = namesOf("person", "bo");
    expect(ada.ok && bo.ok).toBe(true);
    if (!ada.ok || !bo.ok) return;
    expect(ada.names.container).not.toBe(bo.names.container);
    expect(ada.names.profileVolume).not.toBe(bo.names.profileVolume);
  });

  test("a person and a Bot with the same id get different computers", () => {
    const person = namesOf("person", "same");
    const bot = namesOf("bot", "same");
    expect(person.ok && bot.ok).toBe(true);
    if (!person.ok || !bot.ok) return;
    expect(person.names.container).not.toBe(bot.names.container);
    expect(person.names.profileVolume).not.toBe(bot.names.profileVolume);
  });

  test("a person id is held to the same rules as a Bot id", () => {
    for (const id of ["../postgres", "ada/../x", "ada.b", "", "a".repeat(65)]) {
      expect(namesOf("person", id).ok).toBe(false);
    }
  });

  test("only a person or a bot owns a computer", () => {
    for (const kind of ["team", "", "person/../bot", null, 1]) {
      expect(namesOf(kind, "ada").ok).toBe(false);
    }
  });

  test("the names a Bot's computer had before are still derivable, to find its old profile and files", () => {
    const legacy = legacyNamesFor("notes-bot");
    expect(legacy.ok && legacy.names).toEqual({
      botId: "notes-bot",
      container: `${NAMESPACE}-computer-notes-bot`,
      profileVolume: `${NAMESPACE}-profile-notes-bot`,
      workspaceVolume: `${NAMESPACE}-workspace-notes-bot`,
    });
    expect(legacyNamesFor("../x").ok).toBe(false);
  });
});
