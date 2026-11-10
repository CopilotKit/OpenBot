import { queryOptions } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import { client } from "@/lib/client";
import type { CapabilityKey } from "@/lib/enterprise/queries";
import type { CapabilityChange, CapabilityChangesCheck } from "./translate";

/** What the switches decide for one person, and which switch decided it. */
export type CapabilityAnswer = {
  allowed: boolean;
  decidedBy: "default" | "organization" | "role" | "group";
  /** The role or group that decided it. Empty otherwise. */
  scopeId: string;
};

/** A person's own recent use of a permission they would lose, as the trail records it. */
export type CapabilityActivity = {
  /** What is counted, after the number: "actions on their own computer". */
  what: string;
  count: number;
  /** More than were counted. */
  more: boolean;
  /** The newest few rows, for Audit's own cells to draw. */
  recent: AuditEvent[];
};

export type PreviewCapability = {
  capability: CapabilityKey;
  title: string;
  before: CapabilityAnswer;
  after: CapabilityAnswer;
  /** Only for a permission they lose whose use the trail records. */
  activity?: CapabilityActivity;
};

export type PreviewPerson = {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "user";
  groups: string[];
  /** Each permission the changes touch, before and after. */
  capabilities: PreviewCapability[];
};

/**
 * Each member's permissions before and after, decided on the server by the rule OpenBot enforces.
 * `people` lists those losing a permission first, then those gaining one, then those keeping one
 * through a different switch; it is capped, and `counts` is over everybody.
 */
export type CapabilityPreview = {
  check: CapabilityChangesCheck;
  people: PreviewPerson[];
  counts: {
    people: number;
    losing: number;
    gaining: number;
    keeping: number;
    unchanged: number;
  };
  activity: {
    days: number;
    /** Permissions somebody loses whose use the trail does not record. */
    unmapped: { capability: CapabilityKey; title: string }[];
  };
  warning: string | null;
};

export const capabilityChangeKeys = {
  all: ["capability-changes"] as const,
  preview: (changes: readonly CapabilityChange[]) =>
    ["capability-changes", "preview", { changes }] as const,
};

/**
 * Who these changes would change, and whether they check. Writes nothing.
 *
 * Keyed by the changes themselves: the answer is about those changes and nothing else. Not retried,
 * as a boundary's dry-run is not.
 */
export function capabilityChangesPreviewQueryOptions(
  changes: readonly CapabilityChange[],
) {
  return queryOptions({
    queryKey: capabilityChangeKeys.preview(changes),
    queryFn: async (): Promise<CapabilityPreview> =>
      (
        await client("/api/admin/enterprise/capabilities/preview", {
          method: "POST",
          body: { changes },
          fallback: "Couldn't work out who these changes affect.",
        })
      ).json(),
    retry: false,
  });
}
