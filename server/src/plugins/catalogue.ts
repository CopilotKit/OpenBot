/**
 * The catalogue of MCP servers this deployment will talk to, and the rule that decides admissibility.
 *
 * First-party only, and the list is frozen in code. A remote MCP server is a piece of somebody
 * else's software that our Bots hand credentials to and take instructions from, so "which servers"
 * is a decision to make once, in review, rather than one to leave to whoever is typing a URL into an
 * admin page at the time. Only servers the vendor themselves maintains are here. A community server
 * that wraps the same API is not equivalent: it is an extra party in the trust path with none of the
 * accountability, and the answer for a vendor without an official server is to wait for one.
 *
 * Every host and path here comes from the vendor's published documentation. They are pinned rather
 * than discovered, because a URL this deployment will hand a credential to is a reviewed source
 * contract.
 *
 * Admissibility is fail-closed and checked against the pinned host, never against what a caller
 * supplied. A URL that does not exactly match a pinned host, or match one anchored per-instance
 * pattern, is refused. This is the control that stops "add an MCP server" from being a request
 * forgery primitive pointed at the deployment's own network.
 */

/**
 * How a server is authenticated, and whose credential does it.
 *
 * The OAuth addresses are pinned here beside the MCP host, for the same reason and with the same
 * rule: they come from the vendor's published documentation and are never taken from a caller.
 * These are where this deployment sends a person's authorization code and receives the refresh
 * token that stands in for their access, so they are a reviewed source contract too.
 */
// Type-only, so naming the transport here creates no import cycle with the registry that resolves it.
import type { TransportKind } from "./transport";

export type CatalogueAuth =
  /** Answers without any credential at all. */
  | { kind: "none" }
  /** One token, held by the deployment, used for everybody. */
  | { kind: "deployment-bearer" }
  /**
   * The asker's own grant. The deployment registers an OAuth client; each person consents once and
   * the call runs on their token, so the vendor decides what comes back.
   */
  | {
      kind: "user-oauth";
      authorizationUrl: string;
      tokenUrl: string;
      /** Where a disconnect is sent, so revocation happens at the vendor and not just here. */
      revokeUrl: string;
      /**
       * What to ask a person to consent to. Narrow on purpose: a scope granted by everybody who
       * connects and used by nothing is a permission nobody remembers agreeing to.
       */
      scopes: readonly string[];
    };

export type CatalogueEntry = {
  /** Stable slug. Prefixes every tool name, so tools from two servers can never collide. */
  key: string;
  title: string;
  vendor: string;
  summary: string;
  /**
   * The one host this server lives on. Null for a vendor that gives every customer their own
   * hostname, where {@link CatalogueEntry.hostPattern} decides instead.
   */
  host: string | null;
  /**
   * Anchored pattern for a per-instance vendor. Only consulted when `host` is null, and written
   * anchored at both ends so it cannot match a host that merely ends in the vendor's domain.
   */
  hostPattern?: string;
  /** The path the MCP endpoint is served at. Frozen here, never taken from a caller. */
  path: string;
  /**
   * Whose credential this server is reached with.
   *
   * This used to be `needsCredential: boolean`, which said that a credential was required and not
   * whose it was. That is the one thing about a connector worth being unambiguous about: a reader
   * who has to guess guesses the deployment's, and a deployment-wide credential pointed at a
   * per-person system means everybody's question is answered from what one account can see. So the
   * shape names it, and every entry states it.
   *
   * `deployment-bearer` is a token an administrator holds on behalf of everybody. `user-oauth` is
   * the person's own grant, where the deployment holds only the OAuth client and each person
   * consents for themselves.
   */
  auth: CatalogueAuth;
  /**
   * The tools this vendor's server exposes that change something.
   *
   * Kept so the policy can be written about effect rather than about tool names a rule author would
   * have to look up. Known-incomplete for some vendors, which is why {@link classifyTool} treats an
   * unknown tool as a write rather than as a read: a missed write that gets extra scrutiny is safer
   * than a write classified as a read.
   */
  writeTools: readonly string[];
  /**
   * Which protocol reaches this vendor. Absent means MCP, which is what every entry was.
   *
   * A field rather than an inference, because the answer is not derivable from the host: Google
   * serves Drive over both an MCP endpoint and an ordinary REST API, and which one this deployment
   * uses is a decision about availability and risk rather than a property of the vendor. Naming it
   * here keeps that decision beside the host it applies to, and makes reversing it a one-line diff.
   */
  transport?: TransportKind;
  docsUrl: string;
};

/**
 * One entry, deliberately.
 *
 * Atlassian, Box, Slack, Salesforce and ServiceNow were here and were removed: each was a reviewed
 * source contract for a vendor nobody had connected, and a screen offering five untried connectors
 * asserts more than this deployment can stand behind. They are in the history if they are wanted
 * back, and re-adding one is a review of that vendor rather than a revert.
 *
 * `deployment-bearer` therefore has no entry using it. The shape stays because the call path still
 * needs it: a server an administrator added by URL has no catalogue entry at all, and that is the
 * branch it falls into.
 */
export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    key: "google-drive",
    title: "Google Drive",
    vendor: "Google",
    summary: "Files in the Drive of whoever is asking.",
    /*
     * Google publishes one MCP server per Workspace product, each on its own host: Gmail, Docs,
     * Sheets, Slides, Calendar, Chat and People have their own. Drive is here because it is the one
     * a question about a document needs. Each of the others is a further entry, not a flag on this
     * one, so adding Gmail stays a reviewed decision about Gmail.
     */
    /*
     * The GA REST API, not `drivemcp.googleapis.com`.
     *
     * The MCP server was the original choice and is the better one on paper: vendor-maintained, no
     * Drive-specific code here at all. It is gated behind the Google Workspace Developer Preview
     * Program, and an unenrolled project is refused with `The caller does not have permission` —
     * which describes the project, not the credential, so every check available locally reports a
     * correct setup. Enrolment is a Workspace-account application with a stated turnaround of days.
     *
     * This host has been generally available since 2015. The MCP entry is one line away: set
     * `transport` back to `mcp` and restore the host and path above. Tool names match Google's MCP
     * server exactly, so grants survive the swap in either direction.
     */
    host: "https://www.googleapis.com",
    path: "/drive/v3",
    transport: "google-drive-rest",
    /*
     * The first vendor here that cannot be reached with a token an administrator pastes. Google
     * issues no such token: access is an authorization-code grant belonging to a person. That is
     * not a limitation to work around, it is the property this connector exists for — two people
     * asking the same question should get the answers their own accounts can see.
     */
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Read-only, because nothing in this slice writes to anybody's Drive.
      scopes: Object.freeze(["https://www.googleapis.com/auth/drive.readonly"]),
    },
    /*
     * Named writes even though the scope above makes Google refuse them.
     *
     * Belt and braces on purpose. The scope is what stops them; this list is what keeps a boundary
     * written about writes covering them, so widening the scope later cannot quietly turn a write
     * into something the policy engine has never heard of.
     */
    writeTools: Object.freeze(["create_file", "copy_file"]),
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
  },
]);

const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]));

/** Compiled once from the frozen source strings above. Never from anything a caller supplied. */
const PATTERNS = new Map(
  CATALOGUE.filter((entry) => entry.hostPattern !== undefined).map((entry) => [
    entry.key,
    new RegExp(entry.hostPattern as string),
  ]),
);

export function catalogueEntry(key: string): CatalogueEntry | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Is this host one this entry is allowed to be pointed at?
 *
 * Compares the RAW host string, case-sensitively, and returns false for anything it does not
 * positively recognise. Every branch that cannot prove admissibility returns false rather than
 * falling through, because the failure mode of the opposite arrangement is a deployment reaching an
 * address nobody chose.
 */
export function hostAdmissible(entry: CatalogueEntry, host: string): boolean {
  if (entry.host !== null) return entry.host === host;
  const pattern = PATTERNS.get(entry.key);
  if (!pattern) return false;
  return pattern.test(host);
}

/**
 * The URL this server is reached at, or null if the request is not admissible.
 *
 * `instanceHost` is only consulted for a per-instance vendor, and only after the pattern accepts it.
 * The path is always the catalogue's, never the caller's, so an admissible host cannot reach some
 * other endpoint on the same machine.
 */
export function resolveServerUrl(
  key: string,
  instanceHost?: string,
): { url: string; entry: CatalogueEntry } | null {
  const entry = catalogueEntry(key);
  if (!entry) return null;

  const host = entry.host ?? instanceHost ?? null;
  if (host === null) return null;
  if (!hostAdmissible(entry, host)) return null;

  // The path is joined rather than concatenated blindly so a root path does not produce a double
  // slash, which some servers treat as a different route.
  const path = entry.path === "/" ? "" : entry.path;
  return { url: `${host}${path}`, entry };
}

/**
 * What this tool does, in the only two categories a policy author cares about.
 *
 * Unknown counts as a write, in both directions it can be unknown. A tool named in
 * {@link CatalogueEntry.writeTools} is a write. A tool the server advertised and this file has never
 * heard of is a write, because these lists are a verified subset for several vendors rather than the
 * complete surface. A tool the server never advertised at all is a write, because the only thing
 * that produced the name was a model.
 *
 * Only a tool the server itself listed AND that is absent from the write list is treated as a read.
 * That is the one case where both sources agree, and it is the only one where guessing permissively
 * is recoverable.
 */
export function classifyTool(
  entry: CatalogueEntry | null,
  toolName: string,
  advertised: boolean,
): "read" | "write" {
  // A server an administrator added by URL has no reviewed tool catalogue behind it, so nothing here
  // can say a tool of theirs only reads. Everything it offers is a write.
  if (!entry) return "write";
  if (!advertised) return "write";
  return entry.writeTools.includes(toolName) ? "write" : "read";
}

/**
 * Is this a URL an administrator may point the deployment at?
 *
 * A curated entry is reviewed in code; this is the other path, and it needs its own floor because
 * "add an MCP server" is otherwise a request-forgery primitive aimed at whatever the server can
 * reach: cloud metadata endpoints, databases on the same network, admin panels bound to localhost.
 * The rules are deliberately blunt.
 *
 * HTTPS only, because the credential is a bearer token and plaintext is not negotiable.
 * No address literals, localhost or internal suffixes, because those point at the deployment rather
 * than a vendor service.
 *
 * This is static URL validation: it checks the literal host string and scheme before storage. DNS
 * resolution and per-request network policy are separate deployment controls.
 */
export function customUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL.";
  }

  if (url.protocol !== "https:") {
    return "An MCP server must be reached over https.";
  }

  // Userinfo is not part of the host, so none of the host rules below would look at it, and what is
  // typed here is stored verbatim: addCustomServer writes the string into mcp_servers.url and into
  // the configuration.changed audit payload, whose redaction keys on the field name rather than the
  // value. A secret written this way would sit in the trail in clear text. The refusal deliberately
  // does not echo the URL back.
  if (url.username || url.password) {
    return "Put the credential in the token field rather than in the address.";
  }

  // A trailing dot is the root-anchored spelling of the same name and resolves to the same place, so
  // they are stripped here rather than added to each comparison below. Without it "localhost."
  // misses the equality test, "vault.internal." misses the suffix tests, and "database." picks up
  // the dot that the single-label test keys on, so the fully qualified form of every name this
  // function refuses walks straight through it.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");

  // Bracketed IPv6 arrives with the brackets already stripped by URL, so the colon test catches it.
  if (host.includes(":") || /^[0-9.]+$/.test(host)) {
    return "Give a hostname rather than an IP address.";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "That address is local to the deployment.";
  }
  if (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    // How a Kubernetes service is addressed from inside the cluster. It carries dots and none of
    // the suffixes above, so without this it reads as an ordinary vendor name.
    host.endsWith(".svc") ||
    !host.includes(".")
  ) {
    return "That address is not reachable from outside this network.";
  }

  return null;
}
