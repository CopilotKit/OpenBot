import { queryOptions } from "@tanstack/react-query";
import { getWindowsComputer } from "@/lib/api/generated/windows-computer/windows-computer";
import type { WindowsComputer } from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/**
 * The person's Windows computer: whether it is ready, who is using it, and what is being recorded on it
 * (`api/openapi/windows-computer.yaml`). Experimental, and set up for one person only: to anybody else,
 * and wherever none is set up, there is none.
 */
export type { WindowsComputer };

export const windowsComputerKeys = {
  all: ["windows-computer"] as const,
  current: ["windows-computer", "current"] as const,
};

/** The Windows computer, or null when there is none for this person. Read again every few seconds. */
export function windowsComputerQueryOptions() {
  return queryOptions({
    queryKey: windowsComputerKeys.current,
    queryFn: async ({ signal }): Promise<WindowsComputer | null> => {
      try {
        return await getWindowsComputer(organizationId(), {
          signal,
          fallback: "Couldn't load your Windows computer.",
        });
      } catch (error) {
        if (error instanceof ClientError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: 3_000,
  });
}
