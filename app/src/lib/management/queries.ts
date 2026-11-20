import { queryOptions } from "@tanstack/react-query";
import { getManagementEnrollment } from "@/lib/api/generated/copilotkit-management/copilotkit-management";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/**
 * Where connecting this OpenBot to CopilotKit's management service stands.
 *
 * `not-connected`, `waiting-for-approval` (a code waits for somebody signed in to CopilotKit to
 * approve it), `waiting-for-agent` (approved; the admin runs the Helm command and the agent picks
 * up its one-time token from OpenBot itself), `connected` (the agent reports in), `connecting`
 * (OpenBot connects by itself, by its licence, and the agent its chart installed is collecting its
 * token) and `opted-out` (an admin turned managed updates off, so OpenBot doesn't connect by
 * itself). The server's list is open: a state this app doesn't know reads as not connected, so a
 * newer server never breaks the screen.
 */
export type ManagementState =
  | "not-connected"
  | "waiting-for-approval"
  | "waiting-for-agent"
  | "connected"
  | "connecting"
  | "opted-out";

export type ManagementStatus = {
  state: ManagementState;
  /** OpenBot's chart installs the agent: it connects by itself, and Disconnect needs no Helm. */
  agentInstalledByChart?: boolean;
  /** Once connected: `on`, or `not-set-up` when upgrading needs a one-time setup first. */
  upgrades?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: string;
  installId?: string;
  /** Holds nothing secret: the agent collects its token from OpenBot itself. */
  helmCommand?: string;
  /** On a build that isn't a release: which agent the command installs, in the server's own sentence. */
  helmCommandNote?: string;
  /** The name the approval page shows the approver, so the admin can match it. */
  installName?: string;
  /** The install's maintenance window, once connected. */
  window?: { weekday: number; startUtc: string; hours: number };
  lastHeartbeatAt?: string;
  agentVersion?: string;
  /** What went wrong with the last attempt, in the server's own sentence. */
  lastError?: string;
  /**
   * not-entitled: the licence doesn't include managed updates, so Connect isn't offered.
   * invalid-licence and unreachable: lastError says what to do.
   */
  lastErrorCode?: string;
};

/**
 * Whether management applies to this OpenBot at all, and if so where it stands.
 *
 * It applies only to the team edition a company runs itself, in the organization `default`. The
 * server says so: everywhere else (the personal edition, OpenBot Cloud, another organization) it
 * answers 404, with the code MANAGEMENT_UNAVAILABLE where it can, and that answer is
 * `applies: false`, which the Admin rail and the page read as nothing to show.
 */
export type Management =
  | { applies: true; status: ManagementStatus }
  | { applies: false };

const KNOWN: readonly ManagementState[] = [
  "not-connected",
  "waiting-for-approval",
  "waiting-for-agent",
  "connected",
  "connecting",
  "opted-out",
];

export const managementKeys = {
  all: ["management"] as const,
  status: () => ["management", "status"] as const,
};

/** Whether the state means OpenBot is waiting on somebody, so the screen keeps asking. */
export function managementWaiting(state: ManagementState | undefined) {
  return (
    state === "waiting-for-approval" ||
    state === "waiting-for-agent" ||
    state === "connecting"
  );
}

/**
 * Whether to ask at all: never on the personal edition, which has no management to answer for, so
 * Admin there makes no request that fails. Asked once the deployment's edition is known, and also
 * when it couldn't be read: then the server's 404 says the same.
 */
export function asksForManagement(capabilities: {
  isPending: boolean;
  data?: { edition: "team" | "personal" };
}): boolean {
  return !capabilities.isPending && capabilities.data?.edition !== "personal";
}

export function managementQueryOptions() {
  return queryOptions({
    queryKey: managementKeys.status(),
    queryFn: async ({ signal }): Promise<Management> => {
      try {
        const answer = await getManagementEnrollment(organizationId(), {
          signal,
          fallback: "Couldn't load managed updates",
        });
        const state = KNOWN.includes(answer.state as ManagementState)
          ? (answer.state as ManagementState)
          : "not-connected";
        return { applies: true, status: { ...answer, state } };
      } catch (error) {
        // MANAGEMENT_UNAVAILABLE says it in so many words. A bare 404 says the same: the personal
        // edition answers a route it doesn't have with no body, and so does an older server.
        if (error instanceof ClientError && error.status === 404)
          return { applies: false };
        throw error;
      }
    },
    // Asked again every few seconds while waiting on somebody: the approval at CopilotKit's page,
    // or the agent reporting in after the Helm command. Every half minute while connected, so an
    // agent that stops reporting (uninstalled, or its pod down) shows without a reload.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data?.applies) return false;
      if (managementWaiting(data.status.state)) return 5_000;
      return data.status.state === "connected" ? 30_000 : false;
    },
  });
}
