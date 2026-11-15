/**
 * The skills API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads and writes skills through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/skills`: the list comes back as `{ skills, nextCursor }` with
 * `nextCursor` null on the last page, and a skill is written with a PUT to its slug.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

/** Every skill the person can see. */
export const SKILLS_PATH = "/api/v2/organizations/default/skills";

/** One skill's address, which saving and deleting it are sent to. */
export function skillPath(slug: string): string {
  return `${SKILLS_PATH}/${encodeURIComponent(slug)}`;
}

/** A skill as `GET /api/plugins` described it, which a test may give in part. */
export type TodaySkill = {
  slug: string;
  title?: string;
  summary?: string;
  instructions?: string;
  tools?: string[];
  ownerUserId?: string | null;
  grantedTo?: string[];
};

/** The API's skill, from what today's page said about it. */
export function skillBody(today: TodaySkill) {
  return {
    slug: today.slug,
    title: today.title ?? today.slug,
    summary: today.summary ?? "",
    instructions: today.instructions ?? "Do the thing.",
    tools: today.tools ?? [],
    ownerId: today.ownerUserId ?? null,
    botIds: today.grantedTo ?? [],
  };
}

/** One page of skills, as the API answers it. Null ends the list. */
export function skillsResponse(
  skills: readonly TodaySkill[] = [],
  nextCursor: string | null = null,
): Response {
  return NativeResponse.json({ skills: skills.map(skillBody), nextCursor });
}
