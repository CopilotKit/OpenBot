import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The setup checklist, as the server decided it for the person asking. See
 * server/src/setup/checklist.ts.
 *
 * Every sentence and every fix comes from the server, already shaped for its reader: an admin is
 * told which page to open or which variable to set, and a member is told only that it works or that
 * their admin sets it up. The browser draws what it is given and never decides who may see a fix.
 * Nothing on it is a secret's value: a key is reported as there or not there.
 */
export type SetupRowId =
  | "intelligence"
  | "model"
  | "computer"
  | "apps"
  | "chat";

export type SetupFix =
  | {
      kind: "env";
      names: string[];
      docsUrl: string;
      page?: { label: string; path: string };
    }
  | { kind: "page"; label: string; path: string; docsUrl?: string };

/**
 * `ready` works, as far as the server can tell. `needs_setup` does not, and the row says why.
 * `not_checked` is set up, but nobody has asked whether it works, such as a model key added since
 * the server last asked the provider.
 */
export type SetupStatus = "ready" | "needs_setup" | "not_checked";

export type SetupRow = {
  id: SetupRowId;
  /** Every row is the deployment's, which an admin sets up. */
  scope: "deployment";
  title: string;
  /** True only where the product cannot answer without it. */
  required: boolean;
  status: SetupStatus;
  /** `status === "ready"`. */
  ready: boolean;
  /** What it gives you when ready, or what happens without it. */
  detail: string;
  fix: SetupFix | null;
};

export type SetupChecklist = {
  /** Who the server answered as: an admin (or somebody running OpenBot alone) or a member. */
  audience: "admin" | "member";
  rows: SetupRow[];
};

export const setupKeys = {
  all: ["setup"] as const,
  checklist: () => ["setup", "checklist"] as const,
};

export function setupChecklistQueryOptions() {
  return queryOptions({
    queryKey: setupKeys.checklist(),
    queryFn: (): Promise<SetupChecklist> =>
      client("/api/setup", "checklist", {
        fallback: "Couldn't check your setup.",
      }),
  });
}
