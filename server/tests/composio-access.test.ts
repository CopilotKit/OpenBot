import { describe, expect, test } from "bun:test";
import { accessFor } from "../src/plugins/access";
import type { CatalogueEntry } from "../src/plugins/catalogue";
import { catalogueEntry, resolveServerUrl } from "../src/plugins/catalogue";

/**
 * How a server row is reached, resolved once.
 *
 * WHY THIS FILE IS THE IMPORTANT ONE. Three separate decisions used to be derived independently at
 * three call sites: which protocol dials, whose credential is spent, and whose name goes in the audit
 * row. Each derived it from a different field, and a Composio row — which has no catalogue entry at
 * all — answered every one of them wrongly by default: MCP would dial `composio://gmail` as if it
 * were an HTTP server, the credential branch would return no token and proceed, and the trail would
 * say the deployment made a call that ran in somebody's mailbox.
 *
 * One table of expected answers, one row per row-shape that exists. A new kind of server that nobody
 * adds a row for here is a test that fails, which is the property the old three-string-checks
 * arrangement could not have.
 */
describe("accessFor", () => {
  test("a Composio app is dialled through Composio, brokered, and reached as the person", () => {
    // No entry, because an app an operator enabled is a row and not something we shipped.
    expect(
      accessFor({ provenance: "composio", url: "composio://gmail" }, null),
    ).toEqual({
      transport: "composio",
      credential: "brokered",
      reachedAs: "person",
      toolkit: "gmail",
    });
  });

  test("a server somebody added by URL is MCP, on the deployment's own token", () => {
    expect(
      accessFor(
        { provenance: "custom", url: "https://mcp.example.com/mcp" },
        null,
      ),
    ).toEqual({
      transport: "mcp",
      credential: "deployment-token",
      reachedAs: "deployment",
      toolkit: null,
    });
  });

  test("Notion is MCP, on the asking person's own grant", () => {
    const notion = catalogueEntry("notion");
    expect(notion).not.toBeNull();
    if (!notion) return;
    const notionUrl = `${notion.host}${notion.path}`;
    expect(
      accessFor({ provenance: "first-party", url: notionUrl }, notion),
    ).toEqual({
      transport: "mcp",
      credential: "person-oauth",
      reachedAs: "person",
      toolkit: null,
    });
  });

  test("Drive is its REST adapter, on the asking person's own grant", () => {
    const drive = catalogueEntry("google-drive");
    if (!drive) return;
    const driveUrl = `${drive.host}${drive.path}`;
    expect(
      accessFor({ provenance: "first-party", url: driveUrl }, drive),
    ).toEqual({
      transport: "google-drive-rest",
      credential: "person-oauth",
      reachedAs: "person",
      toolkit: null,
    });
  });

  test("Routines is in-process, with no credential, and acts as the person", () => {
    // Resolved the way a row is written rather than spelled by hand. The url this used to carry —
    // `openbot://routines` — is a scheme this codebase does not have anywhere, so the row shape the
    // test claims to cover was not the one being passed in.
    const routines = resolveServerUrl("routines");
    if (!routines) {
      throw new Error(
        "catalogue slug `routines` no longer resolves, so this test asserts nothing about it",
      );
    }
    expect(
      accessFor(
        { provenance: "first-party", url: routines.url },
        routines.entry,
      ),
    ).toEqual({
      transport: "builtin-routines",
      credential: "none",
      reachedAs: "person",
      toolkit: null,
    });
  });

  test("an entry that needs no credential reaches nobody's account, so the trail says the deployment", () => {
    // Constructed here, because no catalogue slug is `auth: { kind: "none" }` yet. Whoever adds the
    // first one gets this answer, and `none` sharing a credential source with `builtin` must not
    // drag it to the person: a public endpoint answers everybody identically.
    const publicEntry: CatalogueEntry = {
      key: "public-thing",
      title: "Public Thing",
      vendor: "Somebody",
      summary: "A server that answers without being told who is asking.",
      // Scheme included, because every non-builtin entry carries one — pinned by
      // `plugin-catalogue.test.ts`. A bare host here made this stand for an entry the catalogue
      // would reject, and the row url below is joined from it so the two cannot drift apart.
      host: "https://mcp.example.com",
      path: "/mcp",
      auth: { kind: "none" },
      writeTools: [],
      docsUrl: "https://example.com/docs",
    };
    expect(
      accessFor(
        {
          provenance: "first-party",
          url: `${publicEntry.host}${publicEntry.path}`,
        },
        publicEntry,
      ),
    ).toEqual({
      transport: "mcp",
      credential: "none",
      reachedAs: "deployment",
      toolkit: null,
    });
  });

  test("a curated entry wins over provenance, so a slug cannot be shadowed into a broker", () => {
    const notion = catalogueEntry("notion");
    // Thrown rather than returned. A missing slug here does not make the property hold, it makes
    // this test stop checking it — and the whole point of the test is that the protection is never
    // unguarded. Renaming the slug must break this file, not quietly empty it.
    if (!notion) {
      throw new Error(
        "catalogue slug `notion` is gone, so nothing here checks that an entry beats provenance",
      );
    }
    // A row whose provenance was tampered with must not turn a reviewed vendor into a brokered one,
    // and must not acquire an app at the broker either — a url edited to `composio://gmail` on a
    // curated slug is the same tampering by another field.
    const shadowed = accessFor(
      { provenance: "composio", url: "composio://gmail" },
      notion,
    );
    expect(shadowed.transport).toBe("mcp");
    expect(shadowed.credential).toBe("person-oauth");
    expect(shadowed.toolkit).toBeNull();
  });

  test("which app a Composio row is comes from its url, not from its id", () => {
    // The id is a display key and the url is what the transport dials, so the url is what decides.
    // A row named `gmail` at `composio://slack` used to be checked against a Gmail connection and
    // then run as Slack, because three places derived this fact and none of them compared answers.
    expect(
      accessFor({ provenance: "composio", url: "composio://slack" }, null)
        .toolkit,
    ).toBe("slack");

    // No app in the url is no app at all. `store.ts` refuses a brokered row that reaches it, rather
    // than falling back to the id — see the narrowing throw beside its connection gate.
    expect(
      accessFor(
        { provenance: "composio", url: "https://example.com/mcp" },
        null,
      ).toolkit,
    ).toBeNull();
  });
});
