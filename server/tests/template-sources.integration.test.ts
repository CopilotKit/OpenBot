/**
 * A registered template source outlives the process that registered it.
 *
 * THE BUG THIS FILE EXISTS FOR. The catalogue kept its registrations in a `Map` and nothing wrote
 * them anywhere. An administrator pinned `owner/repo` to a sha, the deployment restarted, and every
 * source was gone — the gallery quietly narrowed to the templates baked into the image, and
 * `GET /api/admin/templates/settings` answered `sources: []` on a deployment where one had been
 * registered minutes earlier. Nothing had failed, so nothing said anything.
 *
 * A RESTART IS SPELLED AS A SECOND CATALOGUE over the same database. That is the whole trick of this
 * file: `createTemplateCatalogue` holds every registration in the closure it just built, so a fresh
 * one whose only connection to the first is `template_sources` is exactly what the next boot has. A
 * test that re-used the first catalogue would prove that a `Map` remembers what was put in it.
 *
 * The database is real rather than a stub. What is being asserted is that a row is written, read
 * back and deleted, which is precisely the part a stub would agree with regardless.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { templateSources } from "../src/db/schema";
import {
  createTemplateCatalogue,
  type TemplateCatalogue,
} from "../src/templates/catalogue";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 2 },
);

/*
 * Handles nobody else's test uses.
 *
 * The handle is the primary key of `template_sources`, so two files registering
 * `jerelvelarde/awesome-openbot-templates` against the same test database would be writing over each
 * other's row and reading each other's pin. A per-run suffix makes the rows this file cleans up in
 * `afterAll` exactly the rows it wrote.
 */
const suite = randomUUID().slice(0, 8);
const ALLOWED = `openbot-${suite}/templates`;
const WITHDRAWN = `openbot-${suite}/withdrawn`;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MOVED = "fedcba9876543210fedcba9876543210fedcba98";

const admin: AgentActor = { id: "admin@openbot.test", role: "admin" };

/*
 * A skip is announced on `console.warn`, and one of the tests below reads what it announced. Spied
 * on rather than left alone so the suite's output stays quiet, and cleared between tests so a
 * message from an earlier one cannot satisfy a later assertion.
 */
const warned = spyOn(console, "warn").mockImplementation(() => {});

beforeEach(async () => {
  warned.mockClear();
  /*
   * Each test starts from a deployment with no source registered.
   *
   * The rows are what these tests are about, so leaving one behind would let the test that
   * registered it decide what the next one reads back — and the assertions here are about how many
   * rows exist, which is the shape of assertion that goes wrong quietly when order changes.
   */
  await database
    .delete(templateSources)
    .where(inArray(templateSources.id, [ALLOWED, WITHDRAWN]));
});

/**
 * A catalogue over this database, with an empty directory and a fetch that refuses.
 *
 * The directory deliberately does not exist: this file is about registrations, and a directory
 * listing would only add a `console.warn` to read past. Nothing here fetches — every property under
 * test is decided before a URL is built — and an injected `fetch` that throws turns a test that
 * accidentally reached GitHub into a failure rather than a slow pass.
 */
function catalogueWith(allowed: string[]): TemplateCatalogue {
  return createTemplateCatalogue({
    directory: join(tmpdir(), `openbot-templates-absent-${suite}`),
    allowedSources: new Set(allowed),
    installerFloor: "anyone",
    database,
    fetch: async () => {
      throw new Error("No test may reach the network.");
    },
  });
}

/** What the table itself holds for one handle, read past the catalogue rather than through it. */
async function rowsFor(handles: string[]) {
  return database
    .select()
    .from(templateSources)
    .where(inArray(templateSources.id, handles));
}

describe("a registered template source", () => {
  test("is still registered after a restart", async () => {
    const registered = await catalogueWith([ALLOWED]).registerSource(admin, {
      handle: ALLOWED,
      sha: SHA,
    });
    expect(registered.sha).toBe(SHA);

    // The restart: a catalogue that has never seen a registration, reading the same database.
    const rebooted = catalogueWith([ALLOWED]);
    expect(rebooted.sources()).toEqual([]);
    await rebooted.load();

    expect(rebooted.sources()).toHaveLength(1);
    const [source] = rebooted.sources();
    expect(source?.id).toBe(ALLOWED);
    expect(source?.owner).toBe(`openbot-${suite}`);
    expect(source?.repo).toBe("templates");
    expect(source?.sha).toBe(SHA);
    expect(source?.registeredBy).toBe(admin.id);
    expect(source?.registeredAt).toBeInstanceOf(Date);
  });

  test("stops being registered once it is forgotten, row and all", async () => {
    const catalogue = catalogueWith([ALLOWED]);
    await catalogue.registerSource(admin, { handle: ALLOWED, sha: SHA });
    expect(await rowsFor([ALLOWED])).toHaveLength(1);

    expect(await catalogue.forgetSource(admin, ALLOWED)).toBe(true);
    expect(catalogue.sources()).toEqual([]);
    /*
     * The row, not only the memory copy. A forget that left the row behind would come back at the
     * next restart, which is the same bug as the one this table fixed with the sign flipped: an
     * administrator who withdrew a source would find it registered again and nothing would say why.
     */
    expect(await rowsFor([ALLOWED])).toEqual([]);

    const rebooted = catalogueWith([ALLOWED]);
    await rebooted.load();
    expect(rebooted.sources()).toEqual([]);
  });

  test("moving the pin rewrites the one row rather than adding a second", async () => {
    const catalogue = catalogueWith([ALLOWED]);
    await catalogue.registerSource(admin, { handle: ALLOWED, sha: SHA });
    // Spelled the other way GitHub accepts it, because the handle is lowercased into the key and a
    // second row under `Openbot-.../Templates` would be the same repository pinned twice.
    const moved = await catalogue.registerSource(admin, {
      handle: ALLOWED.toUpperCase(),
      sha: MOVED,
    });
    expect(moved.sha).toBe(MOVED);

    const rows = await rowsFor([ALLOWED]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sha).toBe(MOVED);

    const rebooted = catalogueWith([ALLOWED]);
    await rebooted.load();
    expect(rebooted.sources()).toHaveLength(1);
    expect(rebooted.sources()[0]?.sha).toBe(MOVED);
  });

  test("is not loaded once its repository leaves OPENBOT_TEMPLATE_SOURCES, and the skip is named", async () => {
    await catalogueWith([ALLOWED, WITHDRAWN]).registerSource(admin, {
      handle: WITHDRAWN,
      sha: SHA,
    });

    /*
     * The deployment's environment no longer names that repository, which is the operator
     * withdrawing permission to fetch from it. A row saying an administrator once said yes must not
     * be able to give that permission back after the configuration took it away.
     */
    const rebooted = catalogueWith([ALLOWED]);
    await rebooted.load();
    expect(rebooted.sources()).toEqual([]);

    // Named rather than dropped silently: an administrator looking for their source finds out where
    // it went and what to do about it.
    const announced = warned.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(WITHDRAWN));
    expect(announced).toHaveLength(1);
    const skip = JSON.parse(announced[0] ?? "{}") as {
      type: string;
      where: string;
      reason: string;
      message: string;
    };
    expect(skip.type).toBe("template-source-not-allowlisted");
    expect(skip.where).toBe(WITHDRAWN);
    expect(skip.reason).toBe("not_allowlisted");
    expect(skip.message).toContain("OPENBOT_TEMPLATE_SOURCES");

    /*
     * The row is left where it is rather than deleted on the way past. Putting the repository back
     * into the environment is then all it takes to have the pin again, and a boot that destroyed
     * registrations because somebody edited a variable would be the worse surprise.
     */
    expect(await rowsFor([WITHDRAWN])).toHaveLength(1);
  });
});

afterAll(async () => {
  await database
    .delete(templateSources)
    .where(inArray(templateSources.id, [ALLOWED, WITHDRAWN]));
  /*
   * The pool is closed after the cleanup and not before. `bun test` runs every file in one process,
   * so a pool left open holds a connection for the rest of the run and an unrelated file much later
   * dies on the server's connection limit.
   */
  await database.$client.close();
});
