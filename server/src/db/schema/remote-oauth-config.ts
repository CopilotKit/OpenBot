/**
 * What OpenBot learned, when a server added by URL was added, about how that server signs a person
 * in. Stored on `mcp_servers.oauth`; read by `plugins/remote-oauth.ts`.
 *
 * Types only, in the schema directory, so the table can name its column's shape without the schema
 * importing plugin code.
 */
export type RemoteOAuthConfig = {
  /**
   * The authorization server's metadata (RFC 8414, or OpenID discovery), as it was discovered. Kept
   * whole rather than picked apart, because the SDK functions that redeem and refresh a token read
   * it directly: which endpoint, and how the client authenticates there.
   */
  metadata: Record<string, unknown>;
  /** The authorization server, as the protected resource metadata named it. */
  authorizationServer: string;
  /** The resource a token is asked for (RFC 8707): the server's own canonical address. */
  resource: string;
  /** The scope the server asked for, space-separated, when it named one. */
  scope?: string;
};
