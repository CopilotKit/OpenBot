/*
 * Answers for requests that api/openapi.yaml does not describe, so the generated handlers do not
 * answer them. Only calls that every scene needs are here. A scene adds other answers in its own
 * `start.api`. Pattern: the `/info` answer in app/tests/connection-lost-conversation.test.tsx.
 */
import { HttpResponse, http, type RequestHandler } from "msw";
import type {
  ApiControl,
  ApiRoute,
} from "../../../desktop/workbench/appContract";
import { SAM } from "../session";

export const BOTS_ROUTE =
  "GET /api/v2/organizations/:organizationId/bots" satisfies ApiRoute;

/** Runtime agents follow the same effective answer as the app's Bots request. */
export function agentsForBots(api: ApiControl, path: string): string[] {
  const answer = api.answerFor({ method: "GET", path })?.answer;
  if (!answer || (answer.mode !== "value" && answer.mode !== "delay"))
    return [];
  const body = answer.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("bots" in body) ||
    !Array.isArray(body.bots)
  )
    return [];
  return body.bots.flatMap((bot: unknown) =>
    typeof bot === "object" &&
    bot !== null &&
    "id" in bot &&
    typeof bot.id === "string"
      ? [bot.id]
      : [],
  );
}

/**
 * A made-up session for Sam, the person that people/me answers (../session.ts), with fixed times,
 * so each run gives the same answer.
 */
const SIGNED_IN = {
  session: {
    id: "workbench-session",
    token: "workbench-session-token",
    userId: "sam",
    expiresAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "sam",
    name: SAM.name,
    email: SAM.email,
    emailVerified: true,
    image: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

export function extraHandlers(options: {
  agents(): readonly string[];
}): RequestHandler[] {
  return [
    // app/src/lib/copilot/provider.tsx: CopilotKitProvider with runtimeUrl "/api/copilotkit" asks
    // the runtime which agents it has. The list is read for each request, so a scene can change it.
    http.get("*/api/copilotkit/info", () =>
      HttpResponse.json({
        version: "workbench",
        agents: Object.fromEntries(
          options
            .agents()
            .map((id) => [id, { description: "", capabilities: {} }]),
        ),
        mode: "sse",
        telemetryDisabled: true,
      }),
    ),
    // app/src/lib/auth/client.ts: Better Auth's client reads the session from /get-session. It
    // answers the session and its user, or null when no one is signed in.
    http.get("*/api/auth/get-session", () => HttpResponse.json(SIGNED_IN)),
    // app/src/lib/auth/mutations.ts: signOut() calls authClient.signOut(), which Better Auth's
    // server answers with { success: true }.
    http.post("*/api/auth/sign-out", () =>
      HttpResponse.json({ success: true }),
    ),
  ];
}
