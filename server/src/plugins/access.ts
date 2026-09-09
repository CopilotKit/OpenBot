import type { CatalogueEntry } from "./catalogue";
import type { TransportKind } from "./transport";

/**
 * How one server row is reached: which protocol, whose credential, and whose name the trail records.
 *
 * WHY THIS EXISTS AS ONE THING. These three questions were asked separately, in three places, each
 * deriving its own answer from whichever field was nearest. That was complete while every server
 * either had a frozen catalogue entry or was somebody's MCP endpoint. A Composio app is neither: it
 * is a row an operator enabled, with no entry to carry a transport field and no OAuth kind to read,
 * so all three questions answered wrongly by default and each failed silently in its own direction.
 *
 * Resolved once, here, and read as a field everywhere else. A fourth kind of server cannot be added
 * without filling in this function, and the test beside it enumerates every row shape that exists —
 * which is the exhaustiveness the previous arrangement could not offer, since nothing connects three
 * independent string comparisons.
 */

/** Whose credential a call goes out on. */
export type CredentialSource =
  /** One token the deployment holds, used for everybody. */
  | "deployment-token"
  /** The asking person's own OAuth grant, exchanged per call. */
  | "person-oauth"
  /** One key the deployment holds, with the broker keeping people apart by an id we send. */
  | "brokered"
  /** None at all, because the call never leaves this process. */
  | "none";

export type ServerAccess = {
  transport: TransportKind;
  credential: CredentialSource;
  /**
   * Whose account the call reached, as the audit row names it.
   *
   * `person` is the asking person's id and `deployment` is a shared token. Three of the four
   * credential sources reach somebody's own account — including `brokered`, where the deployment
   * holds the key but the call runs in one person's mailbox, which is the whole point of the
   * connector and therefore the only useful thing the trail can say about it.
   */
  reachedAs: "person" | "deployment";
};

const CREDENTIAL_BY_AUTH: Record<
  CatalogueEntry["auth"]["kind"],
  CredentialSource
> = {
  none: "none",
  "deployment-bearer": "deployment-token",
  "user-oauth": "person-oauth",
  builtin: "none",
};

/**
 * A reviewed entry decides for itself; otherwise the row decides.
 *
 * THE ENTRY WINS, AND THAT ORDER IS THE SECURITY PROPERTY. A curated slug's behaviour comes from code
 * that was reviewed, so a row whose provenance column says something else — edited by hand, restored
 * from an old backup, written by a bug — cannot turn a reviewed vendor into a brokered one and start
 * sending its calls somewhere else. The row only ever answers where the catalogue is silent.
 *
 * MCP stays the fallback, which is still right for a server an administrator added by URL: that is
 * somebody else's MCP endpoint by definition, reached on the one token the deployment holds for it.
 */
export function accessFor(
  row: { provenance: string },
  entry: CatalogueEntry | null,
): ServerAccess {
  if (entry) {
    const credential = CREDENTIAL_BY_AUTH[entry.auth.kind];
    return {
      transport: entry.transport ?? "mcp",
      credential,
      reachedAs: credential === "deployment-token" ? "deployment" : "person",
    };
  }

  if (row.provenance === "composio") {
    return {
      transport: "composio",
      credential: "brokered",
      reachedAs: "person",
    };
  }

  return {
    transport: "mcp",
    credential: "deployment-token",
    reachedAs: "deployment",
  };
}
