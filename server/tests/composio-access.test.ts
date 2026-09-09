import { describe, expect, test } from "bun:test";
import { accessFor } from "../src/plugins/access";
import type { CatalogueEntry } from "../src/plugins/catalogue";
import { catalogueEntry } from "../src/plugins/catalogue";

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
    expect(accessFor({ provenance: "composio" }, null)).toEqual({
      transport: "composio",
      credential: "brokered",
      reachedAs: "person",
    });
  });

  test("a server somebody added by URL is MCP, on the deployment's own token", () => {
    expect(accessFor({ provenance: "custom" }, null)).toEqual({
      transport: "mcp",
      credential: "deployment-token",
      reachedAs: "deployment",
    });
  });

  test("Notion is MCP, on the asking person's own grant", () => {
    const notion = catalogueEntry("notion");
    expect(notion).not.toBeNull();
    if (!notion) return;
    expect(accessFor({ provenance: "first-party" }, notion)).toEqual({
      transport: "mcp",
      credential: "person-oauth",
      reachedAs: "person",
    });
  });

  test("Drive is its REST adapter, on the asking person's own grant", () => {
    const drive = catalogueEntry("google-drive");
    if (!drive) return;
    expect(accessFor({ provenance: "first-party" }, drive)).toEqual({
      transport: "google-drive-rest",
      credential: "person-oauth",
      reachedAs: "person",
    });
  });

  test("Routines is in-process, with no credential, and acts as the person", () => {
    const routines = catalogueEntry("routines");
    if (!routines) return;
    expect(accessFor({ provenance: "first-party" }, routines)).toEqual({
      transport: "builtin-routines",
      credential: "none",
      reachedAs: "person",
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
      host: "mcp.example.com",
      path: "/mcp",
      auth: { kind: "none" },
      writeTools: [],
      docsUrl: "https://example.com/docs",
    };
    expect(accessFor({ provenance: "first-party" }, publicEntry)).toEqual({
      transport: "mcp",
      credential: "none",
      reachedAs: "deployment",
    });
  });

  test("a curated entry wins over provenance, so a slug cannot be shadowed into a broker", () => {
    const notion = catalogueEntry("notion");
    if (!notion) return;
    // A row whose provenance was tampered with must not turn a reviewed vendor into a brokered one.
    expect(accessFor({ provenance: "composio" }, notion).transport).toBe("mcp");
    expect(accessFor({ provenance: "composio" }, notion).credential).toBe(
      "person-oauth",
    );
  });
});
