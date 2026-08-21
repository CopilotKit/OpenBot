import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  chunks,
  connectorInstances,
  documentAcls,
  documents,
} from "../src/db/schema";
import { createKnowledgeSearch } from "../src/knowledge/search";
import { TEST_POOL } from "./support/database";

/**
 * The read path, against a real database, because every property worth asserting here is a property
 * of the query.
 *
 * The ACL is evaluated in SQL, so a test that stubbed the database would assert the shape of some
 * TypeScript rather than whether the database hands over a document the asker may not read. That is
 * the whole claim, so it is made against PostgreSQL: full-text search, `row_number`, and the two
 * correlated subqueries are all things only PostgreSQL can be wrong about.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const search = createKnowledgeSearch(database);

const suite = randomUUID().slice(0, 8).replace(/-/g, "");
const asker = { userId: `user_${suite}`, groups: [] as string[] };

/** Ids kept so teardown removes exactly what this file made and nothing else. */
let connectorId = "";
const documentIds: string[] = [];

/**
 * One document with one chunk and a set of ACL rows.
 *
 * `embedding` is required by the schema and is not read by this path, so it is a fixed vector rather
 * than a pretend one: nothing here should read as though it carried meaning.
 */
async function addDocument(input: {
  title: string;
  body: string;
  acls: { principal: string; effect: "allow" | "deny" }[];
  deleted?: boolean;
}): Promise<string> {
  const [document] = await database
    .insert(documents)
    .values({
      connectorInstanceId: connectorId,
      sourceId: `${suite}-${input.title}`,
      title: input.title,
      canonicalUrl: `https://example.invalid/${encodeURIComponent(input.title)}`,
      metadata: {},
      contentHash: randomUUID(),
      ...(input.deleted ? { deletedAt: new Date() } : {}),
    })
    .returning({ id: documents.id });

  const id = document?.id as string;
  documentIds.push(id);

  await database.insert(chunks).values({
    documentId: id,
    position: 0,
    content: input.body,
    embedding: Array.from({ length: 1536 }, () => 0),
  });

  if (input.acls.length > 0) {
    await database.insert(documentAcls).values(
      input.acls.map((acl) => ({
        documentId: id,
        principal: acl.principal,
        effect: acl.effect,
      })),
    );
  }

  return id;
}

beforeAll(async () => {
  const [instance] = await database
    .insert(connectorInstances)
    .values({
      type: "google_drive",
      status: "succeeded",
      sourceMetadata: { suite },
    })
    .returning({ id: connectorInstances.id });
  connectorId = instance?.id as string;
});

afterAll(async () => {
  // Chunks and ACLs cascade from the document, and documents cascade from the connector instance.
  if (documentIds.length > 0) {
    await database.delete(documents).where(inArray(documents.id, documentIds));
  }
  if (connectorId) {
    await database
      .delete(connectorInstances)
      .where(eq(connectorInstances.id, connectorId));
  }
});

describe("answering from what the asker may read", () => {
  test("returns a document the asker is allowed, with a link and a passage", async () => {
    await addDocument({
      title: "Expense policy",
      body: "Meals under seventy five dollars need no receipt. Anything above five hundred needs your manager before you spend it.",
      acls: [{ principal: `user:${asker.userId}`, effect: "allow" }],
    });

    const hits = await search.search({ asker, query: "receipt for meals" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Expense policy");
    // The URL is the connector's, so a citation opens the document rather than a path built here.
    expect(hits[0]?.url).toContain("Expense");
    // A passage rather than the whole chunk, with the matched term marked. This is what makes a
    // citation a citation instead of a title.
    expect(hits[0]?.snippet).toContain("receipt");
  });

  test("does not return a document nothing allows", async () => {
    // Absence is the refusal. A document whose ACLs failed to sync is invisible, not public, which is
    // the same shape every other grant in this repo uses.
    await addDocument({
      title: "Unowned runbook",
      body: "The checkout certificate expired and nobody owned it.",
      acls: [],
    });

    const hits = await search.search({ asker, query: "checkout certificate" });
    expect(hits.map((hit) => hit.title)).not.toContain("Unowned runbook");
  });

  test("does not return a document allowed to somebody else", async () => {
    await addDocument({
      title: "Board minutes",
      body: "The board discussed the acquisition timeline in detail.",
      acls: [{ principal: "user:someone_else", effect: "allow" }],
    });

    const hits = await search.search({ asker, query: "acquisition timeline" });
    expect(hits.map((hit) => hit.title)).not.toContain("Board minutes");
  });

  test("a deny beats an allow on the same document", async () => {
    /*
     * Both rows match this asker. Deny has to win regardless of which row the planner reaches first,
     * which is why it is a `not exists` over the whole ACL set rather than an ordering.
     */
    await addDocument({
      title: "Salary bands",
      body: "Engineering salary bands for the coming year, by level.",
      acls: [
        { principal: `user:${asker.userId}`, effect: "allow" },
        { principal: `user:${asker.userId}`, effect: "deny" },
      ],
    });

    const hits = await search.search({ asker, query: "salary bands level" });
    expect(hits.map((hit) => hit.title)).not.toContain("Salary bands");
  });

  test("a deny on a group beats an allow on the person", async () => {
    // The asker is allowed by name and denied through a group they are in. Still denied.
    const grouped = { userId: asker.userId, groups: ["contractors"] };
    await addDocument({
      title: "Employee handbook",
      body: "Parental leave and sabbatical entitlements for permanent staff.",
      acls: [
        { principal: `user:${asker.userId}`, effect: "allow" },
        { principal: "group:contractors", effect: "deny" },
      ],
    });

    const hits = await search.search({
      asker: grouped,
      query: "parental leave sabbatical",
    });
    expect(hits.map((hit) => hit.title)).not.toContain("Employee handbook");
  });

  test("a group allow reaches somebody in that group and nobody else", async () => {
    /*
     * `users.groups` is written by nothing today, so in this deployment the second half of this is
     * what actually happens for everybody. It is asserted both ways so that the day groups arrive
     * from an identity provider, this test says whether they work rather than needing to be written
     * then.
     */
    await addDocument({
      title: "Finance calendar",
      body: "Quarterly close dates and the reforecast window for each quarter.",
      acls: [{ principal: "group:finance", effect: "allow" }],
    });

    const inFinance = await search.search({
      asker: { userId: asker.userId, groups: ["finance"] },
      query: "quarterly close reforecast",
    });
    expect(inFinance.map((hit) => hit.title)).toContain("Finance calendar");

    const notInFinance = await search.search({
      asker,
      query: "quarterly close reforecast",
    });
    expect(notInFinance.map((hit) => hit.title)).not.toContain(
      "Finance calendar",
    );
  });

  test("does not return a document the connector has deleted", async () => {
    // A soft delete is how a connector reports something removed at the source. Returning it would
    // cite a document that is no longer there.
    await addDocument({
      title: "Retired pricing sheet",
      body: "Legacy pricing tiers withdrawn from sale last year.",
      acls: [{ principal: `user:${asker.userId}`, effect: "allow" }],
      deleted: true,
    });

    const hits = await search.search({ asker, query: "legacy pricing tiers" });
    expect(hits.map((hit) => hit.title)).not.toContain("Retired pricing sheet");
  });

  test("one citation per document, however many passages match", async () => {
    // A long document matching in several places is one citation. Returning it once per chunk would
    // spend the whole answer on it.
    const id = await addDocument({
      title: "Security review",
      body: "Rotation of the signing key is scheduled quarterly.",
      acls: [{ principal: `user:${asker.userId}`, effect: "allow" }],
    });
    await database.insert(chunks).values({
      documentId: id,
      position: 1,
      content: "The signing key rotation runbook lives with the platform team.",
      embedding: Array.from({ length: 1536 }, () => 0),
    });

    const hits = await search.search({ asker, query: "signing key rotation" });
    const mine = hits.filter((hit) => hit.title === "Security review");
    expect(mine).toHaveLength(1);
  });

  test("an empty question asks the database nothing", async () => {
    expect(await search.search({ asker, query: "   " })).toEqual([]);
  });

  test("the number of citations is bounded whatever is asked for", async () => {
    const hits = await search.search({
      asker,
      query: "receipt for meals",
      limit: 9_999,
    });
    expect(hits.length).toBeLessThanOrEqual(20);
  });
});
