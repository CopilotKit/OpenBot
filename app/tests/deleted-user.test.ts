import { expect, test } from "bun:test";
import { chipText } from "@/components/audit/audit-filters";
import {
  DELETED_USER,
  isDeletedUser,
  personLabel,
} from "@/lib/people/deleted-user";

/**
 * How the app names a person who deleted their account, on the rows the server keeps of them: a
 * message with no sender, or a record naming them by the pseudonym the server writes
 * (`deleted-user:` and 32 hex digits of a keyed hash, openbot-backend people/deleted-person.ts).
 */
const GHOST = "deleted-user:8f14e45fceea167a5a36dedd4bea2543";

test("the server's pseudonym is a deleted person, and an ordinary id is not", () => {
  expect(isDeletedUser(GHOST)).toBe(true);
  expect(isDeletedUser("usr_priya")).toBe(false);
  expect(isDeletedUser("")).toBe(false);
  expect(isDeletedUser(null)).toBe(false);
});

test("a person is their name, else their address, else Deleted user", () => {
  expect(personLabel({ name: "Priya Raman", email: "priya@acme.test" })).toBe(
    "Priya Raman",
  );
  expect(personLabel({ name: " ", email: "priya@acme.test" })).toBe(
    "priya@acme.test",
  );
  expect(personLabel({ name: null, email: null })).toBe(DELETED_USER);
  expect(personLabel(null)).toBe("Deleted user");
});

test("Activity's Person filter names a deleted person Deleted user, never the pseudonym", () => {
  const text = chipText("actorUserId", { actorUserId: GHOST }, {
    labels: { apps: {}, bots: {}, people: {}, rules: {} },
    vocabulary: undefined,
    nameFor: (id: string) => id,
  } as never);
  expect(text).toBe("Person: Deleted user");
});
