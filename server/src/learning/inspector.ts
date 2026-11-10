import { z } from "zod";
import type { IntelligenceSettings } from "../config";
import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "../desktop-connection-failure";

/** The longest the overview waits for the Inspector panel: the runtime client's own limit. */
const TIMEOUT_MS = 5_000;

const count = z.number().int().nonnegative();

/**
 * What the Admin overview reads of Intelligence's Inspector Learning snapshot
 * (`GET /api/inspector/learning`, `inspectorLearningSnapshotV1Schema` in Intelligence). An
 * Intelligence with no dashboard answers only a caller that opts in with `dashboardLinksOptional=true`,
 * and then leaves out `webAppOrigin` and `links` and keeps every count. The runtime client neither
 * opts in nor accepts a snapshot without links, so OpenBot reads the route itself. Other fields
 * pass unread.
 */
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  webAppOrigin: z.string().optional(),
  configuration: z.object({
    state: z.enum([
      "not_configured",
      "invalid",
      "configured",
      "selection_required",
    ]),
    container: z.object({ id: z.string(), name: z.string() }).optional(),
  }),
  pendingThreadCount: count,
  pendingCandidateCount: count,
  run: z.object({
    hasActiveRun: z.boolean(),
    latest: z.object({ status: z.string() }).nullable(),
  }),
  skillsPage: z.object({ total: count }),
  insightsPage: z.object({ total: count }),
  links: z
    .object({
      learning: z.string(),
      candidates: z.string().nullable(),
      runs: z.string().nullable(),
    })
    .optional(),
});

export type InspectorLearning = z.output<typeof snapshotSchema>;

export type InspectorLearningRequest = {
  agentId?: string;
  runtimeContainerId?: string;
};

/** Intelligence refused the Inspector read; `status` is its HTTP status (404: no panel here). */
export class InspectorLearningError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InspectorLearningError";
  }
}

/**
 * Reads the Inspector Learning snapshot with the project key this deployment holds, asking for it
 * without dashboard links. An Intelligence from before that opt-in refuses the parameter with 400
 * when it has a dashboard, so the read is then made again without it.
 */
export function createInspectorLearningReader(
  settings: Pick<IntelligenceSettings, "apiUrl" | "apiKey">,
) {
  const get = (input: InspectorLearningRequest, linksOptional: boolean) => {
    const url = new URL(
      `${settings.apiUrl.replace(/\/+$/, "")}/api/inspector/learning`,
    );
    if (input.agentId) url.searchParams.set("agentId", input.agentId);
    if (input.runtimeContainerId)
      url.searchParams.set("runtimeContainerId", input.runtimeContainerId);
    if (linksOptional) url.searchParams.set("dashboardLinksOptional", "true");
    return fetch(url, {
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
  return async (
    input: InspectorLearningRequest,
  ): Promise<InspectorLearning> => {
    let response = await get(input, true);
    if (response.status === 400) response = await get(input, false);
    // The same account of the key as every other Intelligence call (intelligence-client.ts).
    if (response.status === 401)
      recordDesktopConnectionFailure({
        connection: "intelligence",
        code: "intelligence_authentication_failed",
      });
    if (!response.ok)
      throw new InspectorLearningError(
        `The backend's Learning inspector answered ${response.status}`,
        response.status,
      );
    clearDesktopConnectionFailure("intelligence");
    const parsed = snapshotSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success)
      throw new InspectorLearningError(
        "Invalid Inspector Learning response",
        502,
      );
    return parsed.data;
  };
}
