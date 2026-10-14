import { Agent } from "@cursor/sdk";
import {
  approveRun,
  buildPlanFromIssue,
  BUSY_STATUSES,
  extractPrUrl,
  fetchLinearIssue,
  runImplement,
  runResume,
  type CloudAgentConfig,
  type LinearIssue,
} from "product-engineer-loop";
import type { ProductEngineerConfig } from "../config";
import type { ProductEngineerStore } from "./store";

const inFlight = new Set<string>();

export class ProductEngineerBusyError extends Error {
  constructor(ticketId: string) {
    super(
      `A Product Engineer run for ${ticketId} is already in progress, awaiting plan approval, or awaiting review.`,
    );
    this.name = "ProductEngineerBusyError";
  }
}

export class ProductEngineerNotConfiguredError extends Error {
  constructor() {
    super(
      "Product Engineer is not configured. Set CURSOR_API_KEY, LINEAR_API_KEY, and PE_REPOS.",
    );
    this.name = "ProductEngineerNotConfiguredError";
  }
}

export class ProductEngineerNotFoundError extends Error {
  constructor(ticketId: string) {
    super(`No Product Engineer run for ${ticketId}.`);
    this.name = "ProductEngineerNotFoundError";
  }
}

function cloudConfig(config: ProductEngineerConfig): CloudAgentConfig {
  return {
    cursorApiKey: config.cursorApiKey,
    model: config.model,
    repos: config.repos.map((url) =>
      config.startingRef ? { url, startingRef: config.startingRef } : { url },
    ),
  };
}

function peLog(ticketId: string, line: string) {
  console.log(`[product-engineer ${ticketId}] ${line}`);
}

type CursorListedRun = {
  id?: string;
  status?: string;
  updatedAt?: string;
  git?: {
    branches?: { repoUrl?: string; branch?: string; prUrl?: string }[];
  };
};

async function listCursorRuns(
  cursorApiKey: string,
  agentId: string,
): Promise<CursorListedRun[]> {
  const agent = await Agent.resume(agentId, { apiKey: cursorApiKey });
  const client = (
    agent as unknown as {
      client?: {
        listRuns?: (id: string) => Promise<{ items?: CursorListedRun[] }>;
      };
    }
  ).client;
  if (!client?.listRuns) {
    throw new Error("This @cursor/sdk build cannot list cloud runs.");
  }
  const listed = await client.listRuns(agentId);
  return listed.items ?? [];
}

function prFromRuns(runs: CursorListedRun[]): string | null {
  for (const run of runs) {
    for (const branch of run.git?.branches ?? []) {
      if (branch.prUrl) return branch.prUrl;
    }
  }
  return null;
}

/**
 * Start / plan-approve / resume / approve Product Engineer runs.
 * Heavy Cursor work continues in-process after the HTTP response returns —
 * and only after a human has approved the plan.
 */
export function createProductEngineerRunner(
  store: ProductEngineerStore,
  config: ProductEngineerConfig,
) {
  const kickImplement = (normalized: string, issue: LinearIssue) => {
    inFlight.add(normalized);
    void (async () => {
      try {
        const result = await runImplement(
          cloudConfig(config),
          issue,
          (line) => peLog(normalized, line),
          (update) => {
            void store.updateLive(normalized, update);
          },
        );
        const prior = await store.get(normalized);
        await store.save({
          ...result,
          plan: prior?.plan ?? issue.plan ?? null,
          history: [
            ...(prior?.history ?? []).filter(
              (h) => h.kind !== "start" && h.kind !== "approve_plan",
            ),
            ...result.history,
          ],
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        peLog(normalized, `failed: ${message}`);
        await store.setStatus(normalized, "failed", { error: message });
      } finally {
        inFlight.delete(normalized);
      }
    })();
  };

  return {
    /**
     * Fetch the Linear ticket, draft a plan, and wait for human approval.
     * Does not start Cursor cloud coding.
     */
    async start(ticketId: string, startedByUserId: string) {
      const normalized = ticketId.trim().toUpperCase();
      const existing = await store.get(normalized);
      if (
        existing &&
        (BUSY_STATUSES as readonly string[]).includes(existing.status)
      ) {
        throw new ProductEngineerBusyError(normalized);
      }
      if (inFlight.has(normalized)) {
        throw new ProductEngineerBusyError(normalized);
      }

      const issue = await fetchLinearIssue(config.linearApiKey, normalized);
      const plan = buildPlanFromIssue(issue, { repos: config.repos });
      const at = new Date().toISOString();

      const run = existing
        ? await store.save({
            ...existing,
            linearIssueId: issue.id,
            title: issue.title,
            linearUrl: issue.url,
            status: "awaiting_plan_approval",
            repos: config.repos,
            plan,
            agentId: "",
            lastRunId: null,
            prUrl: null,
            error: null,
            progress: null,
            updatedAt: at,
            history: [
              ...existing.history,
              {
                at,
                kind: "start",
                runId: null,
                note: "re-started — plan awaiting approval",
              },
              {
                at,
                kind: "plan",
                runId: null,
                note: "drafted",
              },
            ],
          })
        : await store.insert({
            ticketId: issue.identifier,
            linearIssueId: issue.id,
            title: issue.title,
            linearUrl: issue.url,
            status: "awaiting_plan_approval",
            repos: config.repos,
            plan,
            startedByUserId,
            history: [
              { at, kind: "start", runId: null },
              { at, kind: "plan", runId: null, note: "drafted" },
            ],
          });

      return run;
    },

    /**
     * Human approved the plan — start Cursor cloud coding.
     */
    async approvePlan(ticketId: string) {
      const normalized = ticketId.trim().toUpperCase();
      const existing = await store.get(normalized);
      if (!existing) throw new ProductEngineerNotFoundError(normalized);
      if (existing.status !== "awaiting_plan_approval") {
        throw new Error(
          `Run ${normalized} is ${existing.status}; approve plan only works while awaiting plan approval.`,
        );
      }
      if (!existing.plan?.trim()) {
        throw new Error(`Run ${normalized} has no plan to approve.`);
      }
      if (inFlight.has(normalized)) {
        throw new ProductEngineerBusyError(normalized);
      }

      const at = new Date().toISOString();
      const implementing = await store.save({
        ...existing,
        status: "implementing",
        error: null,
        progress: "Plan approved. Starting Cursor cloud coding…",
        updatedAt: at,
        history: [
          ...existing.history,
          {
            at,
            kind: "approve_plan",
            runId: null,
            note: "plan approved — coding started",
          },
        ],
      });

      const issue = await fetchLinearIssue(config.linearApiKey, normalized);
      kickImplement(normalized, { ...issue, plan: implementing.plan });
      return implementing;
    },

    /**
     * Human rejected or asked to revise the plan — regenerate and wait again.
     */
    async rejectPlan(ticketId: string, feedback: string) {
      const normalized = ticketId.trim().toUpperCase();
      const trimmed = feedback.trim();
      if (!trimmed) {
        throw new Error("feedback is required to revise the plan.");
      }
      const existing = await store.get(normalized);
      if (!existing) throw new ProductEngineerNotFoundError(normalized);
      if (existing.status !== "awaiting_plan_approval") {
        throw new Error(
          `Run ${normalized} is ${existing.status}; revise plan only works while awaiting plan approval.`,
        );
      }

      const issue = await fetchLinearIssue(config.linearApiKey, normalized);
      const plan = buildPlanFromIssue(issue, {
        repos: config.repos,
        feedback: trimmed,
      });
      const at = new Date().toISOString();
      return store.save({
        ...existing,
        linearIssueId: issue.id,
        title: issue.title,
        linearUrl: issue.url,
        status: "awaiting_plan_approval",
        plan,
        error: null,
        progress: null,
        updatedAt: at,
        history: [
          ...existing.history,
          {
            at,
            kind: "reject_plan",
            runId: null,
            note: trimmed.slice(0, 500),
          },
          {
            at,
            kind: "plan",
            runId: null,
            note: "revised",
          },
        ],
      });
    },

    async resume(ticketId: string, feedback: string) {
      const normalized = ticketId.trim().toUpperCase();
      const existing = await store.get(normalized);
      if (!existing) throw new ProductEngineerNotFoundError(normalized);
      if (existing.status !== "awaiting_review") {
        throw new Error(
          `Run ${normalized} is ${existing.status}; resume only works while awaiting review.`,
        );
      }
      if (!existing.agentId) {
        throw new Error(`Run ${normalized} has no Cursor agent id to resume.`);
      }
      if (inFlight.has(normalized)) {
        throw new ProductEngineerBusyError(normalized);
      }

      const revising = await store.setStatus(normalized, "revising", {
        error: null,
      });
      if (!revising) throw new ProductEngineerNotFoundError(normalized);

      inFlight.add(normalized);
      void (async () => {
        try {
          const result = await runResume(
            cloudConfig(config),
            revising,
            feedback,
            (line) => peLog(normalized, line),
            (update) => {
              void store.updateLive(normalized, update);
            },
          );
          await store.save({
            ...result,
            plan: revising.plan ?? null,
            error: null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          peLog(normalized, `resume failed: ${message}`);
          await store.setStatus(normalized, "failed", { error: message });
        } finally {
          inFlight.delete(normalized);
        }
      })();

      return revising;
    },

    async approve(ticketId: string) {
      const normalized = ticketId.trim().toUpperCase();
      const existing = await store.get(normalized);
      if (!existing) throw new ProductEngineerNotFoundError(normalized);
      if (existing.status !== "awaiting_review") {
        throw new Error(
          `Run ${normalized} is ${existing.status}; approve only works while awaiting review.`,
        );
      }
      const approved = approveRun(existing);
      return store.save({
        ...approved,
        plan: existing.plan ?? null,
        error: null,
      });
    },

    /**
     * Re-read Cursor cloud run state into Postgres.
     * Use when the AgentForce process restarted mid-wait and left status stuck.
     */
    async sync(ticketId: string) {
      const normalized = ticketId.trim().toUpperCase();
      const existing = await store.get(normalized);
      if (!existing) throw new ProductEngineerNotFoundError(normalized);
      if (!existing.agentId) {
        throw new Error(
          `Run ${normalized} has no Cursor agent id to sync from.`,
        );
      }

      const runs = await listCursorRuns(config.cursorApiKey, existing.agentId);
      if (runs.length === 0) {
        throw new Error(
          `Cursor returned no runs for agent ${existing.agentId}.`,
        );
      }

      const latest = [...runs].sort((a, b) =>
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
      )[0];
      if (!latest) {
        throw new Error(
          `Cursor returned no runs for agent ${existing.agentId}.`,
        );
      }
      const status = (latest.status ?? "").toUpperCase();
      const prUrl =
        prFromRuns(runs) ?? extractPrUrl(existing.progress) ?? existing.prUrl;
      const lastRunId = latest.id ?? existing.lastRunId;

      if (
        status === "FINISHED" ||
        status === "COMPLETED" ||
        status === "SUCCESS"
      ) {
        return store.save({
          ...existing,
          lastRunId,
          status: "awaiting_review",
          prUrl,
          error: null,
          progress:
            existing.progress ??
            `Synced from Cursor: run ${lastRunId} finished.`,
          updatedAt: new Date().toISOString(),
          history: [
            ...existing.history,
            {
              at: new Date().toISOString(),
              kind: "status",
              runId: lastRunId,
              note: `Synced from Cursor (${status})`,
            },
          ],
        });
      }

      if (
        status === "ERROR" ||
        status === "FAILED" ||
        status === "CANCELLED" ||
        status === "EXPIRED"
      ) {
        return store.save({
          ...existing,
          lastRunId,
          status: "failed",
          prUrl,
          error: `Cursor run ended with status ${status}.`,
          updatedAt: new Date().toISOString(),
          history: [
            ...existing.history,
            {
              at: new Date().toISOString(),
              kind: "status",
              runId: lastRunId,
              note: `Synced from Cursor (${status})`,
            },
          ],
        });
      }

      return store.updateLive(normalized, {
        lastRunId,
        progress: `Cursor run status: ${status || "unknown"}. Still in progress on cloud.`,
      });
    },

    async abandon(ticketId: string, reason?: string) {
      const normalized = ticketId.trim().toUpperCase();
      const existing = await store.get(normalized);
      if (!existing) throw new ProductEngineerNotFoundError(normalized);
      if (
        existing.status !== "implementing" &&
        existing.status !== "revising" &&
        existing.status !== "awaiting_plan_approval" &&
        existing.status !== "awaiting_review"
      ) {
        throw new Error(
          `Run ${normalized} is ${existing.status}; abandon only works while awaiting plan approval, implementing, revising, or awaiting review.`,
        );
      }
      inFlight.delete(normalized);
      return store.save({
        ...existing,
        status: "failed",
        error:
          reason?.trim() ||
          "Marked failed in AgentForce (local wait was lost or abandoned). The Cursor cloud agent may still exist.",
        updatedAt: new Date().toISOString(),
        history: [
          ...existing.history,
          {
            at: new Date().toISOString(),
            kind: "status",
            runId: existing.lastRunId,
            note: "abandoned",
          },
        ],
      });
    },
  };
}

export type ProductEngineerRunner = ReturnType<
  typeof createProductEngineerRunner
>;
