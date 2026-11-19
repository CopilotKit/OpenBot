import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ProductEngineerRunStatus =
  | "awaiting_plan_approval"
  | "implementing"
  | "awaiting_review"
  | "revising"
  | "approved"
  | "failed";

export type ProductEngineerRun = {
  ticketId: string;
  linearIssueId: string;
  title: string;
  linearUrl: string;
  agentId: string;
  lastRunId: string | null;
  status: ProductEngineerRunStatus;
  repos: string[];
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  history: {
    at: string;
    kind:
      | "start"
      | "plan"
      | "approve_plan"
      | "reject_plan"
      | "resume"
      | "status"
      | "approve";
    runId: string | null;
    note?: string;
  }[];
  plan?: string | null;
  progress?: string | null;
  error?: string | null;
};

export const productEngineerKeys = {
  all: ["product-engineer"] as const,
  runs: () => [...productEngineerKeys.all, "runs"] as const,
  run: (ticketId: string) =>
    [...productEngineerKeys.all, "run", ticketId] as const,
};

export function productEngineerRunsQueryOptions() {
  return queryOptions({
    queryKey: productEngineerKeys.runs(),
    queryFn: async (): Promise<{ runs: ProductEngineerRun[] }> => {
      const runs = await client<ProductEngineerRun[]>(
        "/api/product-engineer/runs",
        "runs",
        { fallback: "Could not load Product Engineer runs." },
      );
      return { runs: runs ?? [] };
    },
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      const busy = runs.some(
        (run) => run.status === "implementing" || run.status === "revising",
      );
      return busy ? 4_000 : false;
    },
  });
}
