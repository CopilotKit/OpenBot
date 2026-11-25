import type { Import } from "@/lib/api/generated/model";
import { shortHash } from "./moved-apps";

/**
 * WHERE THE PERSON'S MOVED BOTS ARE, WHEN IT IS NOT THE ORGANIZATION THEY ARE WORKING IN.
 *
 * OpenBot Desktop moves everything into one of the person's organizations on OpenBot Cloud. A
 * browser that signs in can start in another of theirs: the one their account was working in when
 * they signed in, such as their company's. They then see none of what they moved, and nothing says
 * where it is. This names the organization that has their newest finished move, so they can switch
 * to it or move their Bots across to where they are.
 *
 * The newest finished move decides, wherever it is. A move from one organization to another
 * finishes in the organization it went to, so it is the newest there, and the organization it left
 * points to the new one, even though that one still lists the older move in.
 */

/** One of the person's organizations, as the rule reads it. */
export type OrganizationNamed = {
  id: string;
  name: string;
  /**
   * The server's verdict: whether the person may move their Bots into it (Organization.canMoveIn).
   * Absent from an OpenBot Cloud older than moving between organizations, read as allowed.
   */
  canMoveIn?: boolean;
};

/** The organization that has the person's moved Bots, as the bar says it. */
export type MovedElsewhere = {
  organizationId: string;
  organizationName: string;
  /** The computer the move came from, as OpenBot Desktop named it ("OpenBot on Sam's MacBook"). */
  sourceName: string | null;
  /** The notice id that records the bar as closed for this move: `moved-elsewhere-<hash>`. */
  noticeId: string;
  /** The organization the person is working in, which the Bots can be moved into. */
  here: { id: string; name: string; canMoveIn: boolean };
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
 * Where the person's moved Bots are, or null when there is nothing to say: their newest finished
 * move is in the organization they are working in, none of their organizations has one, or they
 * closed the bar for that move (`dismissed`, their preferences' `dismissedNotices`).
 *
 * `imports` holds each organization's moves by id, the one they work in included.
 */
export function movedElsewhere(
  currentId: string,
  organizations: readonly OrganizationNamed[],
  imports: ReadonlyMap<string, readonly Import[]>,
  dismissed: readonly string[],
): MovedElsewhere | null {
  const current = organizations.find((one) => one.id === currentId);
  if (!current) return null;
  let newest: { organization: OrganizationNamed; move: Import } | null = null;
  for (const organization of organizations) {
    for (const move of imports.get(organization.id) ?? []) {
      if (!finished(move)) continue;
      if (!newest || finishedAt(move) > finishedAt(newest.move))
        newest = { organization, move };
    }
  }
  if (!newest || newest.organization.id === currentId) return null;
  const noticeId = movedElsewhereNoticeId(newest.move.id);
  if (dismissed.includes(noticeId)) return null;
  return {
    organizationId: newest.organization.id,
    organizationName: newest.organization.name,
    sourceName: newest.move.sourceName?.trim() || null,
    noticeId,
    here: {
      id: current.id,
      name: current.name,
      canMoveIn: current.canMoveIn !== false,
    },
  };
}

/** The bar's sentence: where the moved Bots are. */
export function movedElsewhereSaid(moved: MovedElsewhere): string {
  return moved.sourceName
    ? `Your Bots from ${moved.sourceName} are in ${moved.organizationName}.`
    : `The Bots you moved to OpenBot Cloud are in ${moved.organizationName}.`;
}
