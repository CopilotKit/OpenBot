import { queryOptions } from "@tanstack/react-query";
import type { AiConnection } from "@/lib/api/generated/model";
import { getAiConnection } from "@/lib/api/generated/models/models";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { invokeDesktop } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";

/**
 * How OpenBot reaches its AI provider (getAiConnection), and whether the Desktop window this page
 * may be in can change it in place.
 */
export type { AiConnection };

export const aiConnectionKeys = {
  all: ["ai-connection"] as const,
  current: ["ai-connection", "current"] as const,
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
