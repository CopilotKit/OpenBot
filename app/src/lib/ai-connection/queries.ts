import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type {
  AiConnection,
  AiConnectionEntry,
  AiConnectionPage,
  AiConnectionProvider,
  PersonalAiConnection,
} from "@/lib/api/generated/model";
import {
  getAiConnection,
  getPersonalAiConnection,
  listAiConnections,
  listPersonalAiConnections,
} from "@/lib/api/generated/models/models";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { invokeDesktop } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";

/**
 * How OpenBot reaches its AI provider (getAiConnection), and whether the Desktop window this page
 * may be in can change it in place. And a person's own AI connection (getPersonalAiConnection),
 * which on OpenBot Cloud each person brings for themselves.
 */
export type { AiConnection, AiConnectionEntry, PersonalAiConnection };

/** Whose AI connections: the organization's (admins), or the signed-in person's own (OpenBot Cloud). */
export type ConnectionScope = "organization" | "personal";

/** Every AI connection in one scope, and the providers the server signs in to for it itself. */
export type AiConnections = {
  connections: AiConnectionEntry[];
  signIns: AiConnectionProvider[];
};

export const aiConnectionKeys = {
  all: ["ai-connection"] as const,
  current: ["ai-connection", "current"] as const,
  personal: ["ai-connection", "personal"] as const,
  list: (scope: ConnectionScope) => ["ai-connection", "list", scope] as const,
  /** The person's answer in another of their organizations, named by its id. */
  personalIn: (organizationId: string) =>
    ["ai-connection", "personal", "in", organizationId] as const,
  // Not under `all`: what Desktop can do does not change when the connection does.
  desktop: ["ai-connection-desktop"] as const,
};

/**
 * The organization's AI connection. Never a key. Null from an OpenBot older than this operation
 * (404), where Settings keeps the Desktop row it had before.
 */
export function aiConnectionQueryOptions() {
  return queryOptions({
    queryKey: aiConnectionKeys.current,
    queryFn: async ({ signal }): Promise<AiConnection | null> => {
      try {
        return await getAiConnection(organizationId(), {
          signal,
          fallback: "Couldn't load the AI connection",
        });
      } catch (error) {
        if (error instanceof ClientError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

async function everyConnection(
  scope: ConnectionScope,
  signal: AbortSignal,
): Promise<AiConnections> {
  const connections: AiConnectionEntry[] = [];
  const seen = new Set<string>();
  let signIns: AiConnectionProvider[] = [];
  let cursor: string | undefined;
  do {
    const params = { limit: 100, ...(cursor ? { cursor } : {}) };
    const options = {
      signal,
      fallback:
        scope === "organization"
          ? "Couldn't load the AI connections."
          : "Couldn't load your AI connections.",
    };
    const page: AiConnectionPage =
      scope === "organization"
        ? await listAiConnections(organizationId(), params, options)
        : await listPersonalAiConnections(
            organizationId(),
            "me",
            params,
            options,
          );
    connections.push(...page.connections);
    signIns = page.signIns;
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return { connections, signIns };
}

/**
 * Every AI connection in a scope, every page read. Never a key. Null from an OpenBot older than
 * several connections (404), or where a person can't have their own (409), where Settings draws
 * the single connection it drew before.
 */
export function aiConnectionsQueryOptions(scope: ConnectionScope) {
  return queryOptions({
    queryKey: aiConnectionKeys.list(scope),
    queryFn: async ({ signal }): Promise<AiConnections | null> => {
      try {
        return await everyConnection(scope, signal);
      } catch (error) {
        if (
          error instanceof ClientError &&
          (error.status === 404 || error.status === 409)
        )
          return null;
        throw error;
      }
    },
  });
}

/**
 * The person's own AI connection, and which AI their runs use. Never a key. Null from an OpenBot
 * older than this operation (404), which reads as "nothing to connect": only OpenBot Cloud requires
 * one, and it answers.
 */
export function personalAiConnectionQueryOptions() {
  return queryOptions({
    queryKey: aiConnectionKeys.personal,
    queryFn: async ({ signal }): Promise<PersonalAiConnection | null> => {
      try {
        return await getPersonalAiConnection(organizationId(), "me", {
          signal,
          fallback: "Couldn't load your AI connection.",
        });
      } catch (error) {
        if (error instanceof ClientError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/**
 * The person's AI connection in another organization of theirs, asked at that organization's own
 * address, so the session stays where it is. Connect your AI offers to work in an organization only
 * when this says it has an AI for everyone (`organization.ready`). Null from an OpenBot older than
 * this operation (404), as above.
 */
export function personalAiConnectionInQueryOptions(organizationId: string) {
  return queryOptions({
    queryKey: aiConnectionKeys.personalIn(organizationId),
    queryFn: async ({ signal }): Promise<PersonalAiConnection | null> => {
      try {
        return await getPersonalAiConnection(organizationId, "me", {
          signal,
          fallback: "Couldn't load your AI connection.",
        });
      } catch (error) {
        if (error instanceof ClientError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/**
 * Whether the person has to connect their own AI before they use OpenBot: the server requires one
 * (OpenBot Cloud) and their runs have none, neither theirs nor the organization's. The server's two
 * verdicts, never recomputed from the connection itself.
 */
export function needsAiConnection(
  personal: PersonalAiConnection | null | undefined,
): boolean {
  return personal?.required === true && personal.uses === "none";
}

/**
 * The same question, for a route's gate. A server that can't answer is read as "not required": a
 * self-hosted OpenBot and an older one never require it, and OpenBot Cloud refuses the run itself
 * with a sentence the chat turns into a way to connect.
 */
export async function aiConnectionRequired(
  queryClient: QueryClient,
): Promise<boolean> {
  try {
    return needsAiConnection(
      await queryClient.ensureQueryData(personalAiConnectionQueryOptions()),
    );
  } catch {
    return false;
  }
}

/**
 * Whether this page is in an OpenBot Desktop that changes the AI connection in place: one that
 * answers `ai_providers`, as every Desktop with `prepare_ai_connection` does. False in a plain
 * browser, true or false in Desktop by what it answers. An older Desktop refuses the command, and
 * Settings keeps its stop-and-setup Change there.
 */
export type DesktopAiSupport = "browser" | "in-place" | "older";

export function desktopAiSupportQueryOptions() {
  return queryOptions({
    queryKey: aiConnectionKeys.desktop,
    queryFn: async (): Promise<DesktopAiSupport> => {
      if (!desktopShell()) return "browser";
      try {
        await invokeDesktop("ai_providers");
        return "in-place";
      } catch {
        return "older";
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
