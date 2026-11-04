/**
 * SCIM 2.0 provisioning, served by Intelligence's organization directory.
 *
 * A directory (Okta, Entra, OneLogin, JumpCloud) is given `<BETTER_AUTH_URL>/api/auth/scim/v2` and the
 * bearer token in `SCIM_BEARER_TOKEN`, as it always was. Intelligence's directory now serves SCIM
 * (`/api/directory/scim/v2` there), with the directory as its store, and this deployment forwards
 * what arrives at its own address there unchanged, so a directory already set up keeps working with
 * nothing reconfigured. At boot this deployment tells Intelligence which tokens its connection accepts,
 * as SHA-256 hashes, never the tokens. A directory may also be pointed at Intelligence's address
 * directly with the same token.
 *
 * From then on:
 * - Creating a user there makes the person in Intelligence; it reaches this deployment through the
 *   directory's announcements, with the `user` role (or `admin` for an address in
 *   INITIAL_ADMIN_EMAILS), and is written to the trail (people/directory/scim-reactions.ts).
 * - Group membership there becomes the person's groups, which per-group capability switches and
 *   per-group network policies read.
 * - Deactivating or deleting the user there records a removal of their address in Intelligence;
 *   here their sessions end, what they connected is retired and their Bots' computers stop.
 *   Reactivating them lifts a removal SCIM made, never one an administrator did.
 *
 * `SCIM_BEARER_TOKEN_NEXT` is accepted alongside the current token for rotation. Off entirely when
 * `SCIM_BEARER_TOKEN` is unset.
 */
import { createHash } from "node:crypto";
import type { DirectoryClient } from "../people/directory/client";

export const SCIM_REVOKED_BY_PREFIX = "scim:";

/** Where this deployment answers SCIM, and the path Intelligence's directory serves it at. */
const OWN_PREFIX = "/api/auth/scim/v2";
const DIRECTORY_PREFIX = "/api/directory/scim/v2";

export function scimStatus(env: Record<string, string | undefined>) {
  const configured = Boolean(env.SCIM_BEARER_TOKEN?.trim());
  const base = env.BETTER_AUTH_URL?.trim().replace(/\/$/, "");
  return {
    configured,
    connectionId: env.SCIM_CONNECTION_ID?.trim() || "directory",
    baseUrl: base ? `${base}${OWN_PREFIX}` : null,
    rotating: Boolean(env.SCIM_BEARER_TOKEN_NEXT?.trim()),
  };
}

/** The connection and the hashes of the tokens it accepts, or null when SCIM is not configured. */
export function scimConnection(
  env: Record<string, string | undefined> = process.env,
): { connectionId: string; tokenHashes: string[] } | null {
  const tokens = [env.SCIM_BEARER_TOKEN, env.SCIM_BEARER_TOKEN_NEXT]
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token));
  if (!env.SCIM_BEARER_TOKEN?.trim()) return null;
  return {
    connectionId: env.SCIM_CONNECTION_ID?.trim() || "directory",
    tokenHashes: tokens.map((token) =>
      createHash("sha256").update(token, "utf8").digest("hex"),
    ),
  };
}

/**
 * Tell Intelligence's directory which tokens this deployment's SCIM connection accepts. Called at
 * every boot, so changing or rotating `SCIM_BEARER_TOKEN` takes effect with a restart, as it did.
 */
export async function registerScimConnection(
  client: Pick<DirectoryClient, "putScimConnection">,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const connection = scimConnection(env);
  if (!connection) return false;
  await client.putScimConnection(
    connection.connectionId,
    connection.tokenHashes,
  );
  return true;
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Forwards a SCIM request that arrived at this deployment's address to Intelligence's directory, and
 * its answer back. The bearer token goes as it came: Intelligence checks it against the hashes. The
 * addresses in the answer (`Location`, `meta.location`, a member's `$ref`) are rewritten to this
 * deployment's, so the directory goes on seeing the address it was given.
 *
 * After a write the directory accepted, `afterWrite` runs before the directory is answered: a
 * deactivation's sessions end here before the directory hears it is done, as they did.
 */
export function createScimForwarder(options: {
  intelligenceApiUrl: string;
  /** This deployment's own SCIM address; from the request when absent. */
  publicBaseUrl?: string | null;
  afterWrite?: () => Promise<void>;
  fetch?: typeof fetch;
}) {
  const directoryBase = `${options.intelligenceApiUrl.replace(/\/+$/, "")}${DIRECTORY_PREFIX}`;
  const send = options.fetch ?? fetch;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const rest = url.pathname.slice(
      url.pathname.indexOf(OWN_PREFIX) + OWN_PREFIX.length,
    );
    const ownBase =
      options.publicBaseUrl?.replace(/\/+$/, "") ??
      `${url.origin}${OWN_PREFIX}`;
    const headers: Record<string, string> = {
      accept: request.headers.get("accept") ?? "application/scim+json",
    };
    const authorization = request.headers.get("authorization");
    if (authorization) headers.authorization = authorization;
    const contentType = request.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    let answer: Response;
    try {
      answer = await send(`${directoryBase}${rest}${url.search}`, {
        method: request.method,
        headers,
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: await request.arrayBuffer() }),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "scim-forward-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json(
        {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "503",
          detail: "The directory could not be reached. Try again.",
        },
        { status: 503, headers: { "content-type": "application/scim+json" } },
      );
    }
    const rewrite = (text: string) =>
      text.replace(/https?:\/\/[^"\s]*?\/api\/directory\/scim\/v2/g, ownBase);
    const body = answer.status === 204 ? null : rewrite(await answer.text());
    const out = new Headers();
    for (const name of [
      "content-type",
      "www-authenticate",
      "cache-control",
      "etag",
    ]) {
      const value = answer.headers.get(name);
      if (value) out.set(name, value);
    }
    const location = answer.headers.get("location");
    if (location) out.set("location", rewrite(location));
    if (WRITES.has(request.method) && answer.ok && options.afterWrite) {
      try {
        await options.afterWrite();
      } catch (error) {
        // The directory's change stands; what follows here is retried by the reactions' own timer.
        console.error(
          JSON.stringify({
            type: "scim-after-write-failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return new Response(body, { status: answer.status, headers: out });
  };
}
