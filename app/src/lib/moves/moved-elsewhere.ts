import type { Import } from "@/lib/api/generated/model";
import { shortHash } from "./moved-apps";

/**
 * WHERE THE PERSON'S MOVED BOTS ARE, WHEN IT IS NOT THE ORGANIZATION THEY ARE WORKING IN.
 *
 * OpenBot Desktop moves everything into the person's own organization on OpenBot Cloud. A browser
 * that signs in can start in another of theirs: the one their account was working in when they
 * signed in, such as their company's. They then see none of what they moved, and nothing says where
 * it is. This names the organization that has their newest finished move, so they can switch to it.
 */

/** One of the person's organizations, as the rule reads it. */
export type OrganizationNamed = { id: string; name: string };

/** The organization that has the person's moved Bots, as the bar says it. */
export type MovedElsewhere = {
  organizationId: string;
  organizationName: string;
  /** The computer the move came from, as OpenBot Desktop named it ("OpenBot on Sam's MacBook"). */
  sourceName: string | null;
  /** The notice id that records the bar as closed for this move: `moved-elsewhere-<hash>`. */
  noticeId: string;
};

function finished(move: Import): boolean {
  return move.status === "imported";
}

/** When a finished move finished, for the newest first. */
function finishedAt(move: Import): number {
  const at = Date.parse(move.finishedAt ?? move.createdAt);
  return Number.isNaN(at) ? 0 : at;
}

/** The notice id for one move, the same on every device. */
export function movedElsewhereNoticeId(importId: string): string {
  return `moved-elsewhere-${shortHash(importId)}`;
}

/**
 * Where the person's moved Bots are, or null when there is nothing to say: they are working in an
 * organization that has a finished move of theirs, none of their other organizations has one, or
 * they closed the bar for that move (`dismissed`, their preferences' `dismissedNotices`).
 *
 * `imports` holds each organization's moves by id, the one they work in included. The newest
 * finished move in another organization is the one named.
 */
export function movedElsewhere(
  currentId: string,
  organizations: readonly OrganizationNamed[],
  imports: ReadonlyMap<string, readonly Import[]>,
  dismissed: readonly string[],
): MovedElsewhere | null {
  if ((imports.get(currentId) ?? []).some(finished)) return null;
  let newest: { organization: OrganizationNamed; move: Import } | null = null;
  for (const organization of organizations) {
    if (organization.id === currentId) continue;
    for (const move of imports.get(organization.id) ?? []) {
      if (!finished(move)) continue;
      if (!newest || finishedAt(move) > finishedAt(newest.move))
        newest = { organization, move };
    }
  }
  if (!newest) return null;
  const noticeId = movedElsewhereNoticeId(newest.move.id);
  if (dismissed.includes(noticeId)) return null;
  return {
    organizationId: newest.organization.id,
    organizationName: newest.organization.name,
    sourceName: newest.move.sourceName?.trim() || null,
    noticeId,
  };
}

/** The bar's sentence: where the moved Bots are. */
export function movedElsewhereSaid(moved: MovedElsewhere): string {
  return moved.sourceName
    ? `Your Bots from ${moved.sourceName} are in ${moved.organizationName}.`
    : `The Bots you moved to OpenBot Cloud are in ${moved.organizationName}.`;
}
