import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  hostAdmissible,
  resolveServerUrl,
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
    const atlassian = catalogueEntry("atlassian");
    expect(atlassian).not.toBeNull();
    expect(hostAdmissible(atlassian!, "https://mcp.atlassian.com")).toBe(true);
    // A prefix, a suffix and a lookalike are each refused. The suffix case is the one that matters:
    // a check written with endsWith rather than equality would accept it.
    expect(
      hostAdmissible(atlassian!, "https://mcp.atlassian.com.evil.test"),
    ).toBe(false);
    expect(
      hostAdmissible(atlassian!, "https://evil.test/mcp.atlassian.com"),
    ).toBe(false);
    expect(hostAdmissible(atlassian!, "http://mcp.atlassian.com")).toBe(false);
  });

  test("a per-instance vendor accepts its own instances and nothing else", () => {
    const servicenow = catalogueEntry("servicenow");
    expect(servicenow).not.toBeNull();
    expect(hostAdmissible(servicenow!, "https://acme.service-now.com")).toBe(
      true,
    );
    expect(
      hostAdmissible(servicenow!, "https://acme-dev1.service-now.com"),
    ).toBe(true);
    // Anchored at both ends, so neither a prefix nor a suffix gets in.
    expect(
      hostAdmissible(servicenow!, "https://acme.service-now.com.evil.test"),
    ).toBe(false);
    expect(
      hostAdmissible(servicenow!, "https://evil.test#acme.service-now.com"),
    ).toBe(false);
    // A subdomain of an instance is not an instance.
    expect(hostAdmissible(servicenow!, "https://a.b.service-now.com")).toBe(
      false,
    );
  });

  test("a server not in the catalogue resolves to nothing", () => {
    expect(resolveServerUrl("not-a-vendor")).toBeNull();
    expect(catalogueEntry("not-a-vendor")).toBeNull();
  });

  test("the path is the catalogue's, never the caller's", () => {
    // A per-instance vendor is the only case where a caller supplies any part of the address, and
    // even then the path is fixed, so an admissible host cannot reach another endpoint.
    const resolved = resolveServerUrl(
      "servicenow",
      "https://acme.service-now.com",
    );
    expect(resolved?.url).toBe(
      "https://acme.service-now.com/sncapps/mcp-server",
    );
  });

  test("a per-instance vendor with no instance supplied resolves to nothing", () => {
    expect(resolveServerUrl("servicenow")).toBeNull();
  });

  test("every catalogue entry pins a host or an anchored pattern", () => {
    for (const entry of CATALOGUE) {
      if (entry.host === null) {
        expect(entry.hostPattern).toBeDefined();
        // Anchored at both ends or the pattern is decoration.
        expect(entry.hostPattern?.startsWith("^")).toBe(true);
        expect(entry.hostPattern?.endsWith("$")).toBe(true);
      } else {
        expect(entry.host.startsWith("https://")).toBe(true);
      }
    }
  });
});

describe("whose credential a server uses", () => {
  test("every entry says which, rather than leaving it to be inferred", () => {
    // The whole point of replacing a `needsCredential` boolean. "Needs a credential" did not say
    // whose, and a reader who guessed would guess the deployment's, which for a user-oauth vendor
    // is the one answer that breaks the promise the connector exists to keep.
    for (const entry of CATALOGUE) {
      expect(["none", "deployment-bearer", "user-oauth"]).toContain(
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
      // does not name us.
      expect(entry.auth.scopes.length).toBeGreaterThan(0);
    }
  });

  test("the five token vendors did not quietly become user-oauth", () => {
    for (const key of [
      "atlassian",
      "box",
      "slack",
      "salesforce",
      "servicenow",
    ]) {
      expect(catalogueEntry(key)?.auth.kind).toBe("deployment-bearer");
    }
  });
});

describe("Google Drive", () => {
  const drive = catalogueEntry("google-drive");

  test("resolves to the one address Google publishes for it", () => {
    expect(drive).not.toBeNull();
    expect(resolveServerUrl("google-drive")?.url).toBe(
      "https://drivemcp.googleapis.com/mcp/v1",
    );
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

describe("what a tool does", () => {
  const atlassian = catalogueEntry("atlassian")!;

  test("a named write is a write", () => {
    expect(classifyTool(atlassian, "createJiraIssue", true)).toBe("write");
  });

  test("an advertised tool that is not a named write is a read", () => {
    expect(classifyTool(atlassian, "searchJiraIssues", true)).toBe("read");
  });

  test("a tool the server never advertised is a write", () => {
    // The only thing that produced this name was a model, so nothing has vouched for it.
    expect(classifyTool(atlassian, "searchJiraIssues", false)).toBe("write");
  });

  test("every tool on a server nobody reviewed is a write", () => {
    expect(classifyTool(null, "anything_at_all", true)).toBe("write");
  });

  test("a tool that edits rather than creates is still a write", () => {
    // The naming does not carry it: "update" and "create" both change somebody else's system, and a
    // list built by reading verbs off tool names lets the edits through.
    const slack = catalogueEntry("slack")!;
    expect(classifyTool(slack, "slack_update_canvas", true)).toBe("write");
    expect(classifyTool(slack, "slack_create_canvas", true)).toBe("write");
    expect(classifyTool(slack, "slack_read_canvas", true)).toBe("read");
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

  test("nonsense is refused rather than thrown", () => {
    expect(customUrlRefusal("not a url")).toBe("That is not a URL.");
  });
});
