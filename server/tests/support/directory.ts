// server/tests/support/directory.ts
//
// People for the tests, in a real Intelligence.
//
// People live in Intelligence's organization directory, with this deployment's `users` table as its
// projection. A test that needs a person makes them there, through the same directory the server
// uses, and the row here follows from Intelligence's answer. There is no stand-in: a fake directory
// that passed while the real one refused would be exactly the test that lies.
//
// WHICH INTELLIGENCE. The one `TEST_INTELLIGENCE_API_URL` and `TEST_INTELLIGENCE_API_KEY` name (see
// support/bots.ts); missing, every test that touches a person fails here and says so.
//
// The directory installed here is NOT started: it never reads the whole project into the test
// database (the test project holds the people of every run before this one), and it subscribes to
// nothing. Writes go to Intelligence and come back to the row, as on a server. The projection's own
// suite starts a directory of its own, against a project of its own.
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/client";
import { createDirectoryClient } from "../../src/people/directory/client";
import {
  createPeopleDirectory,
  installPeopleDirectory,
  type PeopleDirectory,
} from "../../src/people/directory/directory";
import type { Person, PersonDraft } from "../../src/people/directory/types";
import { testIntelligence } from "./bots";
import { testDatabaseUrl } from "./database";

let installed: PeopleDirectory | undefined;

/** The process's people directory, against the test Intelligence, installed. Once per process. */
export function useTestPeople(): PeopleDirectory {
  if (installed) return installed;
  const intelligence = testIntelligence();
  installed = installPeopleDirectory(
    createPeopleDirectory({
      client: createDirectoryClient({
        apiUrl: intelligence.apiUrl,
        apiKey: intelligence.apiKey,
      }),
      database: createDatabase(testDatabaseUrl(), { max: 2 }),
    }),
  );
  return installed;
}

/**
 * A directory for one more deployment's database, for a test that runs several deployments in one
 * process: the same test project, its people projected into that database. Not installed, not started.
 */
export function directoryFor(
  database: ReturnType<typeof createDatabase>,
): PeopleDirectory {
  const intelligence = testIntelligence();
  return createPeopleDirectory({
    client: createDirectoryClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    }),
    database,
  });
}

/** An address no earlier run of the suite has used: the test project keeps every run's people. */
export function uniqueEmail(label = "person"): string {
  return `${label}-${randomUUID().slice(0, 12)}@example.test`;
}

/**
 * Make a person in Intelligence, and so their row here, for a test. A plain user with a fresh
 * address unless the test says otherwise.
 */
export async function seedDirectoryPerson(
  input: Partial<PersonDraft> = {},
): Promise<Person> {
  const directory = useTestPeople();
  const id = input.id ?? `test-person-${randomUUID()}`;
  return directory.create({
    id,
    email: input.email ?? uniqueEmail(),
    name: input.name ?? "Test Person",
    image: input.image ?? null,
    emailVerified: input.emailVerified ?? true,
    role: input.role ?? "user",
    ...input,
  });
}

/** Remove people for good, here and in Intelligence, as test cleanup. */
export async function purgeDirectoryPeople(
  ids: readonly string[],
): Promise<void> {
  const directory = useTestPeople();
  for (const id of ids) {
    try {
      await directory.purge(id);
    } catch (error) {
      console.warn(`could not purge test person ${id}: ${String(error)}`);
    }
  }
}

/** Lift removals a test made, so the next run starts with those addresses admitted. */
export async function liftRemovals(emails: readonly string[]): Promise<void> {
  const directory = useTestPeople();
  for (const email of emails) await directory.removals.lift(email);
}
