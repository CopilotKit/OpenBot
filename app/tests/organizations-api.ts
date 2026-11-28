import type { OrganizationMember } from "@/lib/api/generated/model";

/**
 * An organization's members as the API answers them (listOrganizationMembers,
 * api/openapi/organizations.yaml), for a test that fakes `fetch` by hand: at
 * `/api/v2/organizations/default/members`, `limit` from 1 to 100 (50 when none is given), a
 * `nextCursor` while more remain and null on the last page.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

export const MEMBERS_PATH = "/api/v2/organizations/default/members";

/** One member, by name and address, with the role a test gives them. Override any field. */
export function organizationMember(
  name: string | null,
  email: string,
  role: "owner" | "admin" | "member" | string,
  overrides: Partial<OrganizationMember> = {},
): OrganizationMember {
  return {
    id: `usr_${email.split("@")[0]}`,
    email,
    name,
    image: null,
    role,
    joinedAt: "2026-11-01T09:00:00.000Z",
    removable: role !== "owner",
    assignableRoles: [],
    ...overrides,
  };
}

/**
 * One page of `members` for the request at `url`, as the API pages it. The cursor is where the next
 * page starts; one this list didn't give out is the API's 400.
 */
export function membersResponse(
  url: string,
  members: readonly OrganizationMember[],
): Response {
  const query = new URL(url, "http://127.0.0.1").searchParams;
  const limit = Number(query.get("limit") ?? "50");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return NativeResponse.json(
      {
        type: "https://open.bot/errors/validation-error",
        title: "Request validation failed.",
        status: 400,
        detail: "limit must be from 1 to 100.",
        code: "VALIDATION_ERROR",
      },
      { status: 400, headers: { "content-type": "application/problem+json" } },
    );
  const cursor = query.get("cursor");
  const start = cursor === null ? 0 : Number(cursor);
  const end = start + limit;
  return NativeResponse.json({
    members: members.slice(start, end),
    nextCursor: end < members.length ? String(end) : null,
  });
}
