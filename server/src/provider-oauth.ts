import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Env, Hono } from "hono";
import { z } from "zod";
import { sameToken } from "./agents/callback-token";
import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "./desktop-connection-failure";
import { googleRequest, googleResponse } from "./google-oauth-transport";
import {
  CredentialLockUnavailable,
  lockProviderCredentials,
} from "./provider-oauth-lock";

export type ModelOAuthRecord = {
  version: 1;
  sessionId: string;
  provider: "google" | "xai";
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  quotaProject?: string;
  proxyToken: string;
};

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export type ModelProviderProxy = (request: Request) => Promise<Response>;

const schema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  provider: z.enum(["google", "xai"]),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite().positive(),
  scope: z.string(),
  quotaProject: z.string().min(1).optional(),
  proxyToken: z.string().min(1),
});

const providers = {
  google: {
    token: "https://oauth2.googleapis.com/token",
  },
  xai: {
    token: "https://auth.x.ai/oauth2/token",
    chat: "https://api.x.ai/v1/chat/completions",
  },
};

class SignInRequired extends Error {}

async function readRecord(file: string): Promise<ModelOAuthRecord> {
  // Windows ignores O_NOFOLLOW. Bind its no-follow path metadata to the opened
  // handle before reading bytes, so a replacement between lstat/open is refused.
  const before =
    process.platform === "win32"
      ? await lstat(file, { bigint: true })
      : undefined;
  if (before && (!before.isFile() || before.ino === 0n))
    throw new Error("The private model credential path is not valid.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (before && (before.dev !== info.dev || before.ino !== info.ino))
      throw new Error(
        "The private model credential path changed while opening.",
      );
    if (
      !info.isFile() ||
      info.size > 64n * 1024n ||
      (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)
    )
      throw new Error("The private model credential file is not valid.");
    const record = schema.parse(JSON.parse(await handle.readFile("utf8")));
    if (record.provider === "google" && !record.quotaProject)
      throw new Error("The Google model quota project is missing.");
    return record;
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Native sign-in uses the same lock. A new session must win over an older refresh. */
async function persistRotation(
  file: string,
  previous: ModelOAuthRecord,
  next: ModelOAuthRecord,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const current = await readRecord(file);
    if (
      current.sessionId !== previous.sessionId ||
      current.refreshToken !== previous.refreshToken
    )
      throw new SignInRequired("The model sign-in changed during refresh.");
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

function refused(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** One host-server instance owns refresh; agents use only its separate local bearer. */
export function createProviderOAuthProxy(
  file: string,
  options: { fetch?: Fetch } = {},
): ModelProviderProxy {
  if (!isAbsolute(file))
    throw new Error("The model OAuth file must be absolute.");
  const requestProvider = options.fetch ?? fetch;
  const refreshes = new Map<string, Promise<ModelOAuthRecord>>();

  async function refresh(
    previous: ModelOAuthRecord,
  ): Promise<ModelOAuthRecord> {
    const pending = refreshes.get(previous.sessionId);
    if (pending) return pending;
    const work = (async () => {
      const unlock = await lockProviderCredentials(file);
      try {
        const current = await readRecord(file);
        if (current.sessionId !== previous.sessionId)
          throw new SignInRequired("The model sign-in changed.");
        // A concurrent request may have already rotated the token that received a 401.
        if (current.accessToken !== previous.accessToken) return current;
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: current.clientId,
          refresh_token: current.refreshToken,
        });
        if (current.clientSecret)
          body.set("client_secret", current.clientSecret);
        const response = await requestProvider(
          providers[current.provider].token,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
            },
            body,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new SignInRequired("The model provider refused token refresh.");
        }
        const tokens = z
          .object({
            access_token: z.string().min(1),
            refresh_token: z.string().min(1).optional(),
            expires_in: z.number().finite().positive().optional(),
            token_type: z.string().optional(),
          })
          .parse(await response.json());
        if (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer")
          throw new SignInRequired(
            "The model provider returned an unsupported token.",
          );
        const next = {
          ...current,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? current.refreshToken,
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        };
        // Do not use a rotated pair until it is durable; a failed save requires sign-in again.
        await persistRotation(file, current, next);
        return next;
      } finally {
        await unlock();
      }
    })();
    refreshes.set(previous.sessionId, work);
    try {
      return await work;
    } finally {
      refreshes.delete(previous.sessionId);
    }
  }

  return async (request) => {
    let current: ModelOAuthRecord;
    try {
      current = await readRecord(file);
    } catch {
      return refused(
        503,
        "The local model sign-in is unavailable. Sign in again.",
      );
    }
    const offered = request.headers.get("authorization") ?? "";
    if (!sameToken(offered, `Bearer ${current.proxyToken}`))
      return refused(401, "The local model proxy requires authentication.");

    let body: ArrayBuffer;
    try {
      body = await request.arrayBuffer();
    } catch {
      return refused(400, "The model request body could not be read.");
    }
    try {
      if (current.expiresAt <= Date.now() + 120_000)
        current = await refresh(current);
    } catch (error) {
      if (error instanceof CredentialLockUnavailable)
        return refused(
          503,
          "The model credential store is busy or unavailable. Try again.",
        );
      recordDesktopConnectionFailure({
        connection: "model",
        code: "provider_authentication_failed",
      });
      return refused(
        401,
        "The model sign-in could not be refreshed. Sign in again.",
      );
    }

    let google: ReturnType<typeof googleRequest> | undefined;
    if (current.provider === "google") {
      try {
        google = googleRequest(JSON.parse(new TextDecoder().decode(body)));
      } catch {
        return refused(
          400,
          "The Google model request has unsupported or invalid content.",
        );
      }
    }

    const send = (credential: ModelOAuthRecord) => {
      const headers = new Headers({
        "content-type": "application/json",
        authorization: `Bearer ${credential.accessToken}`,
      });
      if (credential.provider === "google" && credential.quotaProject)
        headers.set("x-goog-user-project", credential.quotaProject);
      return requestProvider(google?.url ?? providers.xai.chat, {
        method: "POST",
        headers,
        body: google ? JSON.stringify(google.body) : body,
        redirect: "error",
        signal: request.signal,
      });
    };
    try {
      let response = await send(current);
      if (response.status === 401) {
        await response.body?.cancel();
        try {
          current = await refresh(current);
        } catch (error) {
          if (error instanceof CredentialLockUnavailable) throw error;
          throw new SignInRequired("The model sign-in could not be refreshed.");
        }
        response = await send(current);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          throw new SignInRequired("The model provider refused this sign-in.");
        return refused(
          response.status >= 400 ? response.status : 502,
          `The model provider rejected the request (HTTP ${response.status}).`,
        );
      }
      clearDesktopConnectionFailure("model");
      if (google)
        return await googleResponse(
          response,
          google.model,
          google.stream,
          google.includeUsage,
        );
      return new Response(response.body, {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      if (error instanceof CredentialLockUnavailable)
        return refused(
          503,
          "The model credential store is busy or unavailable. Try again.",
        );
      if (error instanceof SignInRequired) {
        recordDesktopConnectionFailure({
          connection: "model",
          code: "provider_authentication_failed",
        });
        return refused(401, "The model provider needs you to sign in again.");
      }
      return refused(502, "The model provider could not be reached.");
    }
  };
}

export function mountProviderOAuthProxy<T extends Env>(
  app: Hono<T>,
  proxy: ModelProviderProxy | undefined,
): void {
  if (proxy)
    app.post("/api/model-provider/v1/chat/completions", (context) =>
      proxy(context.req.raw),
    );
}
