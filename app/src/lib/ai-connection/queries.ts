import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type {
  AiConnection,
  PersonalAiConnection,
} from "@/lib/api/generated/model";
import {
  getAiConnection,
  getPersonalAiConnection,
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
export type { AiConnection, PersonalAiConnection };

export const aiConnectionKeys = {
  all: ["ai-connection"] as const,
  current: ["ai-connection", "current"] as const,
  personal: ["ai-connection", "personal"] as const,
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
