import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  hostAdmissible,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";

/**
 * The catalogue decides two things that are worth being sure about: which addresses this deployment
 * will talk to at all, and which of a server's tools change something.
 *
 * Both fail closed, and both are tested for that rather than for the happy path. An admissibility
 * check that accepts one address too many is a request-forgery primitive; an effect classifier that
 * calls a write a read is a governance surface that quietly stops covering the thing it exists for.
 */

describe("which servers this deployment will talk to", () => {
  test("a pinned host matches only itself", () => {
    const drive = catalogueEntry("google-drive");
    expect(drive).not.toBeNull();
    expect(hostAdmissible(drive!, "https://www.googleapis.com")).toBe(true);
    // A prefix, a suffix and a lookalike are each refused. The suffix case is the one that matters:
    // a check written with endsWith rather than equality would accept it.
    expect(hostAdmissible(drive!, "https://www.googleapis.com.evil.test")).toBe(
      false,
    );
    expect(hostAdmissible(drive!, "https://evil.test/www.googleapis.com")).toBe(
      false,
    );
    expect(hostAdmissible(drive!, "http://www.googleapis.com")).toBe(false);
    // The MCP host this entry used to name. Now inadmissible, which is the point of pinning: moving
    // the entry to the GA API is also a decision to stop talking to the preview endpoint.
    expect(hostAdmissible(drive!, "https://drivemcp.googleapis.com")).toBe(
      false,
    );
  });

  test("an entry whose pattern this build never compiled is refused", () => {
    /*
     * WHAT THIS NO LONGER COVERS. ServiceNow was the only per-instance entry, and removing it took
     * the anchored-pattern assertions with it — that a prefix, a suffix and a subdomain are each
     * refused. `PATTERNS` is compiled from the catalogue by key, so a synthetic entry cannot reach a
     * pattern and there is no way left to exercise the matching itself through the public API.
     *
     * What survives is the fail-closed half, which is worth keeping on its own: an entry claiming to
     * be per-instance that this build has no pattern for is refused rather than admitted. Whoever
     * adds the next per-instance vendor should restore the anchoring cases with it.
     */
    const perInstance = {
      key: "google-drive",
      title: "Per-instance vendor",
      vendor: "Example",
      summary: "",
      host: null,
      hostPattern:
        "^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)\\.service-now\\.com$",
      path: "/mcp",
      auth: { kind: "deployment-bearer" },
      writeTools: [],
      docsUrl: "",
    } as const;

    // `PATTERNS` is compiled from the catalogue by key, so a synthetic entry reaches no pattern and
    // is refused outright. That is itself the fail-closed property: no pattern means no.
    expect(hostAdmissible(perInstance, "https://acme.service-now.com")).toBe(
      false,
    );
  });

  test("a server not in the catalogue resolves to nothing", () => {
    expect(resolveServerUrl("not-a-vendor")).toBeNull();
    expect(catalogueEntry("not-a-vendor")).toBeNull();
  });

  test("the path is the catalogue's, never the caller's", () => {
    // An instance host offered for a vendor with a pinned host is ignored, not honoured: the host and
    // the path both come from the entry, so nothing a caller sends can reach another endpoint.
    expect(resolveServerUrl("google-drive", "https://evil.test").url).toBe(
      "https://www.googleapis.com/drive/v3",
    );
  });

  test("every catalogue entry pins a host or an anchored pattern", () => {
    for (const entry of CATALOGUE) {
      if (entry.host === null) {
        expect(entry.hostPattern).toBeDefined();
        // Anchored at both ends or the pattern is decoration.
        expect(entry.hostPattern?.startsWith("^")).toBe(true);
        expect(entry.hostPattern?.endsWith("$")).toBe(true);
      } else if (entry.auth.kind === "builtin") {
        /*
         * First-party and in-process: there is no host outside this process to reach, so the
         * https requirement below does not apply. Asserted against a list rather than against the
         * `builtin://` scheme, so this branch cannot quietly become a loophole for a future entry
         * that DOES dial a real host: adding one means adding it here, deliberately.
         */
        expect(["builtin://routines", "builtin://mailbox"]).toContain(
          entry.host,
        );
      } else {
        expect(entry.host.startsWith("https://")).toBe(true);
      }
    }
  });
});

describe("whose credential a server uses", () => {
  test("a builtin entry says whether it is reached as the asker or as the deployment", () => {
    /*
     * The one question the audit trail asks about a call with no vendor. Routines touches the
     * asker's own rows; Mailbox opens one mailbox the deployment owns, on a password the deployment
     * holds. Recording the second as the asker would put a person's id on a row describing access
     * that was never theirs, so every builtin has to state it rather than inherit a guess.
     */
    for (const entry of CATALOGUE) {
      if (entry.auth.kind !== "builtin") continue;
      expect(["actor", "deployment"]).toContain(entry.auth.reachedAs);
    }
  });

  test("every entry says which, rather than leaving it to be inferred", () => {
    // The whole point of replacing a `needsCredential` boolean. "Needs a credential" did not say
    // whose, and a reader who guessed would guess the deployment's, which for a user-oauth vendor
    // is the one answer that breaks the promise the connector exists to keep.
    for (const entry of CATALOGUE) {
      expect(["none", "deployment-bearer", "user-oauth", "builtin"]).toContain(
        entry.auth.kind,
      );
    }
  });

  test("a user-oauth entry pins its own endpoints over https and asks for a scope", () => {
    for (const entry of CATALOGUE) {
      if (entry.auth.kind !== "user-oauth") continue;
      // Pinned for the same reason the MCP host is: these are addresses this deployment sends a
      // person's authorization code and receives their refresh token at.
      expect(entry.auth.authorizationUrl.startsWith("https://")).toBe(true);
      expect(entry.auth.tokenUrl.startsWith("https://")).toBe(true);
      expect(entry.auth.revokeUrl.startsWith("https://")).toBe(true);
      // No scopes means consent to nothing, which would fail at the vendor with a message that
      // does not name us — except for a vendor whose consent screen itself is the scoping
      // (Notion, with dynamic client registration), where a scope string would assert a control
      // that does not exist.
      if (entry.auth.clientRegistration !== "dynamic") {
        expect(entry.auth.scopes.length).toBeGreaterThan(0);
      }
      if (entry.auth.clientRegistration === "dynamic") {
        expect(entry.auth.registrationUrl?.startsWith("https://")).toBe(true);
      }
    }
  });

  test("a vendor this build has never heard of is not an entry", () => {
    // The five bearer vendors that used to be asserted here are gone. What matters now is the same
    // property from the other side: a key with no entry resolves to nothing rather than to a default.
    for (const key of [
      "atlassian",
      "box",
      "slack",
      "salesforce",
      "servicenow",
    ]) {
      expect(catalogueEntry(key)).toBeNull();
      expect(resolveServerUrl(key)).toBeNull();
    }
  });
});

describe("Google Drive", () => {
  const drive = catalogueEntry("google-drive");

  test("resolves to the one address Google publishes for it", () => {
    expect(drive).not.toBeNull();
    /*
     * The GA REST API, not the MCP server. Google publishes both; the MCP one is gated behind the
     * Workspace Developer Preview Program and refuses an unenrolled project with a message about
     * permission that describes the project rather than the credential. Swapping back is `transport`
     * plus these two fields, which is why the transport is asserted alongside the address.
     */
    expect(resolveServerUrl("google-drive")?.url).toBe(
      "https://www.googleapis.com/drive/v3",
    );
    expect(drive?.transport).toBe("google-drive-rest");
  });

  test("is reached as the person asking, not as the deployment", () => {
    expect(drive?.auth.kind).toBe("user-oauth");
  });

  test("asks only to read", () => {
    // K1 answers questions and writes nothing. A wider scope would be granted by every person who
    // connects and used by nothing, which is the kind of permission nobody remembers agreeing to.
    expect(drive?.auth.kind === "user-oauth" ? drive.auth.scopes : []).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
  });

  test("still calls its writes writes, and lets Google be the one to refuse them", () => {
    // The read-only scope means these fail at the vendor. They stay classified as writes anyway, so
    // a boundary written about writes keeps covering them if the scope ever widens.
    expect(classifyTool(drive, "create_file", true)).toBe("write");
    expect(classifyTool(drive, "copy_file", true)).toBe("write");
    expect(classifyTool(drive, "search_files", true)).toBe("read");
    expect(classifyTool(drive, "read_file_content", true)).toBe("read");
  });
});

describe("Notion", () => {
  const entry = catalogueEntry("notion");

  test("is in the catalogue with the MCP transport", () => {
    expect(entry).not.toBeNull();
    // Transport omitted means MCP, which is the point: Drive's REST adapter is the exception.
    expect(entry?.transport).toBeUndefined();
    expect(entry?.host).toBe("https://mcp.notion.com");
    expect(entry?.path).toBe("/mcp");
  });

  test("registers its client dynamically, with every endpoint pinned to https", () => {
    if (entry?.auth.kind !== "user-oauth") throw new Error("wrong auth kind");
    expect(entry.auth.clientRegistration).toBe("dynamic");
    expect(entry.auth.registrationUrl?.startsWith("https://")).toBe(true);
    expect(entry.auth.authorizationUrl.startsWith("https://")).toBe(true);
    expect(entry.auth.tokenUrl.startsWith("https://")).toBe(true);
    // Notion MCP scoping is the consent screen; scope strings would assert control that
    // does not exist.
    expect(entry.auth.scopes).toEqual([]);
  });

  test("pins the exact write list, so a dropped or renamed entry fails here", () => {
    // Copied from the catalogue's Notion entry, in its declared order. This list is the
    // entire write barrier for Notion (see the comment above writeTools in catalogue.ts) —
    // asserting membership against itself would never catch a silently dropped or renamed
    // tool, so the fix is to pin the literal names.
    expect(entry?.writeTools).toEqual([
      "notion-convert-page-to-skill",
      "notion-create-attachment",
      "notion-create-comment",
      "notion-create-database",
      "notion-create-file-upload",
      "notion-create-folder",
      "notion-create-pages",
      "notion-create-view",
      "notion-duplicate-page",
      "notion-move-pages",
      "notion-update-data-source",
      "notion-update-folder",
      "notion-update-page",
      "notion-update-view",
    ]);
    for (const name of entry?.writeTools ?? []) {
      expect(classifyTool(entry, name, true)).toBe("write");
    }
    expect(classifyTool(entry, "notion-search", true)).toBe("read");
    expect(classifyTool(entry, "brand-new-tool", false)).toBe("write");
  });
});

describe("Routines", () => {
  const entry = catalogueEntry("routines");

  test("is in the catalogue and resolves to its own builtin address", () => {
    expect(entry).not.toBeNull();
    expect(resolveServerUrl("routines")?.url).toBe("builtin://routines");
  });

  test("has no credential, because there is nothing to authenticate to", () => {
    // Reached as the person asking, unlike the other builtin: a routine is theirs, and the audit
    // trail should say whose rows a call touched.
    expect(entry?.auth).toEqual({ kind: "builtin", reachedAs: "actor" });
  });

  test("is reached through the builtin transport, not a vendor", () => {
    expect(entry?.transport).toBe("builtin-routines");
  });

  test("pins the exact write list, so a dropped or renamed entry fails here", () => {
    expect(entry?.writeTools).toEqual([
      "create_routine",
      "update_routine",
      "delete_routine",
    ]);
  });

  test("classifies its tools the same way every other vendor's are classified", () => {
    for (const name of entry?.writeTools ?? []) {
      expect(classifyTool(entry, name, true)).toBe("write");
    }
    expect(classifyTool(entry, "list_routines", true)).toBe("read");
    // A name nothing here has vouched for is a write, the same as for any other vendor.
    expect(classifyTool(entry, "brand-new-tool", false)).toBe("write");
    // Every tool, advertised or not, is a write when the server never said it was advertised.
    for (const name of [
      ...(entry?.writeTools ?? []),
      "list_routines",
      "brand-new-tool",
    ]) {
      expect(classifyTool(entry, name, false)).toBe("write");
    }
  });
});

describe("Mailbox", () => {
  const entry = catalogueEntry("mailbox");

  test("is in the catalogue and resolves to its own builtin address", () => {
    expect(entry).not.toBeNull();
    expect(resolveServerUrl("mailbox")?.url).toBe("builtin://mailbox");
  });

  test("has no per-person credential, because there is one mailbox and it is the deployment's", () => {
    expect(entry?.auth).toEqual({ kind: "builtin", reachedAs: "deployment" });
    // `builtin` takes no credential from the server row, so nothing an administrator points at this
    // entry is ever spent. The mailbox password is resolved from the vault by its own key instead.
    expect(serverCredentialKind(entry as CatalogueEntry)).toBeNull();
  });

  test("is reached through its own builtin transport, not a vendor and not Routines", () => {
    expect(entry?.transport).toBe("builtin-mailbox");
  });

  test("pins the exact write list, so a dropped or renamed entry fails here", () => {
    // One write, and the reason this entry is grantable per tool: reading mail is recoverable and
    // sending it is not.
    expect(entry?.writeTools).toEqual(["send_message"]);
  });

  test("classifies its tools the same way every other vendor's are classified", () => {
    expect(classifyTool(entry, "send_message", true)).toBe("write");
    expect(classifyTool(entry, "list_messages", true)).toBe("read");
    expect(classifyTool(entry, "read_message", true)).toBe("read");
    expect(classifyTool(entry, "search_messages", true)).toBe("read");
    // A name nothing here has vouched for is a write, the same as for any other vendor.
    expect(classifyTool(entry, "delete_message", false)).toBe("write");
    // Every tool, advertised or not, is a write when the server never said it was advertised.
    for (const name of [
      "send_message",
      "list_messages",
      "read_message",
      "search_messages",
    ]) {
      expect(classifyTool(entry, name, false)).toBe("write");
    }
  });
});

describe("what a tool does", () => {
  const drive = catalogueEntry("google-drive")!;

  test("a named write is a write", () => {
    expect(classifyTool(drive, "create_file", true)).toBe("write");
  });

  test("an advertised tool that is not a named write is a read", () => {
    expect(classifyTool(drive, "search_files", true)).toBe("read");
  });

  test("a tool the server never advertised is a write", () => {
    // The only thing that produced this name was a model, so nothing has vouched for it.
    expect(classifyTool(drive, "search_files", false)).toBe("write");
  });

  test("every tool on a server nobody reviewed is a write", () => {
    expect(classifyTool(null, "anything_at_all", true)).toBe("write");
  });

  test("copying is a write, and reading a file's content is not", () => {
    // `copy_file` is the case a list built by reading verbs off tool names would miss: it creates
    // nothing named "create" and still puts a new object in somebody's Drive.
    expect(classifyTool(drive, "copy_file", true)).toBe("write");
    expect(classifyTool(drive, "read_file_content", true)).toBe("read");
    expect(classifyTool(drive, "get_file_metadata", true)).toBe("read");
  });
});

describe("a URL an administrator typed", () => {
  test("an ordinary vendor URL is accepted", () => {
    expect(customUrlRefusal("https://mcp.example.com/mcp")).toBeNull();
  });

  test("plaintext is refused", () => {
    expect(customUrlRefusal("http://mcp.example.com")).toContain("https");
  });

  test("an address literal is refused", () => {
    // The cloud metadata endpoint, which is the reason this check exists.
    expect(
      customUrlRefusal("https://169.254.169.254/latest/meta-data/"),
    ).toContain("hostname");
    expect(customUrlRefusal("https://127.0.0.1/mcp")).toContain("hostname");
    expect(customUrlRefusal("https://[::1]/mcp")).toContain("hostname");
  });

  test("names that only resolve inside the network are refused", () => {
    expect(customUrlRefusal("https://localhost/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://database/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://printer.local/mcp")).not.toBeNull();
  });

  test("the fully qualified spelling of those names is refused too", () => {
    // A trailing dot is the root-anchored form of the same name and resolves to the same place, so
    // every rule above has to see through it. It defeats them in two different ways: the suffix
    // tests stop matching because the string now ends in the dot, and "database." acquires the dot
    // that the single-label test keys on.
    expect(customUrlRefusal("https://localhost./mcp")).not.toBeNull();
    expect(customUrlRefusal("https://database./mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal./mcp")).not.toBeNull();
    expect(customUrlRefusal("https://printer.local./mcp")).not.toBeNull();
    expect(
      customUrlRefusal("https://metadata.google.internal./computeMetadata/v1/"),
    ).not.toBeNull();
    // More than one, because stripping a single dot leaves a string that still misses every rule.
    expect(customUrlRefusal("https://localhost../mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal.../mcp")).not.toBeNull();
  });

  test("an in-cluster service name is refused", () => {
    // .svc is how a Kubernetes service is addressed from inside the cluster. It has dots and none
    // of the other suffixes, so it reads as an ordinary vendor name.
    expect(
      customUrlRefusal("https://kubernetes.default.svc/mcp"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://kubernetes.default.svc.cluster.local/mcp"),
    ).not.toBeNull();
  });

  test("a credential in the URL is refused", () => {
    // Userinfo is not part of the host, so every rule above passes it, and addCustomServer then
    // writes the string it was given into mcp_servers.url and into the configuration.changed audit
    // payload. Audit redaction keys on the field name and "url" is not sensitive, so the secret
    // would sit in the trail in clear text.
    expect(
      customUrlRefusal("https://oauth:s3cret@mcp.example.com/mcp"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://token@mcp.example.com/mcp"),
    ).not.toBeNull();
  });

  test("refusing a credential in the URL does not repeat the credential", () => {
    // The refusal is rendered to the administrator and can reach a log, so it must not carry the
    // thing it exists to reject.
    const refusal = customUrlRefusal(
      "https://oauth:s3cret@mcp.example.com/mcp",
    );
    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain("s3cret");
    expect(refusal).not.toContain("oauth");
  });

  test("a credential in the query string is refused", () => {
    // The same harm as the userinfo case above, reached through the other part of the URL no host
    // rule looks at. addCustomServer writes the string it was given into mcp_servers.url and into
    // the configuration.changed audit payload, audit redaction keys on the field name, and "url" is
    // not a sensitive name, so a token here sits in an append-only trail in clear text.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?token=sk-live-abcdef"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?api_key=SECRET"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?access_token=SECRET"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?client_secret=SECRET"),
    ).not.toBeNull();
  });

  test("the names a credential is actually given are refused too", () => {
    // The first version of this rule listed exact names, which is a corner of the class rather than
    // the class: every one of these was accepted while `?token=` was refused, and an operator does
    // not know which spelling the check happens to hold. The match reads the name for what it says.
    for (const name of [
      "auth_token",
      "api_token",
      "apiToken",
      "access_key",
      "secret_key",
      "private_key",
      "session_token",
      "x-api-key",
      "subscription-key",
      "X-Amz-Signature",
      "bearer",
      "pwd",
    ]) {
      expect(
        customUrlRefusal(`https://mcp.example.com/mcp?${name}=s3cret`),
      ).not.toBeNull();
    }
  });

  test("an ordinary query parameter is still accepted", () => {
    // The rule reads the parameter name, not the presence of a query, because vendors route and
    // version with parameters. Refusing every query string would make this floor an outage rather
    // than a guard, and an operator who cannot add a working server will find a way around it.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?workspace=acme&version=2"),
    ).toBeNull();
    // The near misses, which are what a rule that reads names rather than matching them exactly has
    // to get right: "keyword" is not a key and "author" is not auth.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?keyword=x&author=jane"),
    ).toBeNull();
  });

  test("refusing a credential in the query does not repeat it", () => {
    // Same property as the userinfo refusal: this string is rendered to an administrator and can
    // reach a log, so it must not carry the secret it exists to reject.
    const refusal = customUrlRefusal(
      "https://mcp.example.com/mcp?token=s3cret",
    );
    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain("s3cret");
    expect(refusal).not.toContain("mcp.example.com");
  });

  test("a credential in the fragment is refused too", () => {
    // The fragment never leaves the browser, but that is not the harm here. addCustomServer stores
    // and audits the whole string, so a secret written after the hash is as durable and as readable
    // as one in the query. Refusing one and not the other would leave the same bypass a character
    // away.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#token=s3cret"),
    ).not.toBeNull();
    // The shapes a fragment is actually written in. A hash route or an OAuth-style callback puts a
    // path before the question mark, and reading the whole fragment as one query string turns all
    // of it into a single name that matches nothing.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#/callback?token=s3cret"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#!/x?token=s3cret"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#token%3Ds3cret"),
    ).not.toBeNull();
    // An ordinary fragment is not a credential and is left alone.
    expect(customUrlRefusal("https://mcp.example.com/mcp#section")).toBeNull();
  });

  test("the short name for the cloud metadata endpoint is refused", () => {
    // metadata.goog is Google's own alias for the metadata server, published beside
    // metadata.google.internal and 169.254.169.254. It carries a dot and none of the suffixes
    // above, so it read as an ordinary vendor name, while the long spelling was caught only
    // incidentally by the .internal test.
    expect(
      customUrlRefusal("https://metadata.goog/computeMetadata/v1/"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://metadata.goog./computeMetadata/v1/"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://METADATA.GOOG/computeMetadata/v1/"),
    ).not.toBeNull();
  });

  test("nonsense is refused rather than thrown", () => {
    expect(customUrlRefusal("not a url")).toBe("That is not a URL.");
  });
});

describe("which credential a curated server is given", () => {
  /**
   * A synthetic entry, because the catalogue holds one vendor today and it is `user-oauth`.
   *
   * The shared-token branch is the one a fork re-enables when it puts a removed vendor back, which
   * is the case this rule exists for, so it is exercised here rather than left to be discovered
   * then. The other side of the same argument is why the entry is written out in full rather than
   * spread from a real one: what is under test is the auth kind deciding the answer.
   */
  const sharedToken: CatalogueEntry = {
    key: "shared-token-vendor",
    title: "Vendor",
    vendor: "Vendor",
    summary: "A server the deployment holds one token for.",
    host: "https://mcp.vendor.example",
    path: "/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: [],
    docsUrl: "https://vendor.example/docs",
  };

  test("a shared-token server takes the deployment's own token for it", () => {
    expect(serverCredentialKind(sharedToken)).toBe("mcp");
  });

  test("a server reached as the asker takes no credential from the caller", () => {
    // Its OAuth client arrives through registerOAuthClient, which mints the credential itself. An id
    // offered here is therefore never the right one, whatever kind it names.
    const drive = catalogueEntry("google-drive");
    expect(drive?.auth.kind).toBe("user-oauth");
    expect(serverCredentialKind(drive as CatalogueEntry)).toBeNull();
  });

  test("a server that needs no credential takes none", () => {
    expect(
      serverCredentialKind({ ...sharedToken, auth: { kind: "none" } }),
    ).toBeNull();
  });
});
