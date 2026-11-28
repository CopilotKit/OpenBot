import type {
  OrganizationInvitation,
  OrganizationMember,
  Team,
  TeamBot,
  TeamMember,
} from "@/lib/api/generated/model";
import { meResponse } from "./accounts-api";
import { teamBotOf } from "./bots-api";
import { answerGroupRead, type GroupFixture } from "./conversations-api";

/**
 * The API, as people-lists.test.tsx's screens reach it: an organization (Acme Freight, `default`)
 * with more members, invitations and teams than one page holds, and a second organization whose
 * people must never show in Acme's lists or pickers.
 *
 * Every list answers as the spec says (api/openapi/organizations.yaml, teams.yaml): `limit` from 1
 * to 100, 50 when none is given; `search` matched anywhere in the name or address, ignoring case,
 * best matches first for the members; a `nextCursor` while more remain and null at the end; and a
 * cursor that belongs to the list and the search that made it, refused for any other with the
 * API's 400.
 */

export const ORGANIZATION = "/api/v2/organizations/default";
const OTHER_ORGANIZATION = "/api/v2/organizations/harbor";

type Person = { id: string; name: string; email: string };

const person = (name: string, domain = "acme.test"): Person => {
  const local = name
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .split(" ")
    .join(".");
  return { id: local.replace(/\./g, "-"), name, email: `${local}@${domain}` };
};

/** Who is signed in: an admin of Acme Freight. */
export const DANA = person("Dana Whitfield");
/** The three whose names hold "sar". Nobody else in Acme's lists does. */
export const SARAH = person("Sarah Chen");
export const SARA = person("Sara Lindqvist");
export const SARITA = person("Sarita Patel");

const OTHERS = [
  "Aaron Blake",
  "Abel Moreno",
  "Ada Novak",
  "Adrian Holt",
  "Aiko Tanaka",
  "Alan Pierce",
  "Alice Dupont",
  "Amir Haddad",
  "Ana Ruiz",
  "Ben Foster",
  "Bianca Rossi",
  "Boris Ivanov",
  "Carl Jensen",
  "Chloe Martin",
  "Dmitri Volkov",
  "Eli Cohen",
  "Elena Petrova",
  "Emil Berg",
  "Erin Walsh",
  "Felix Wagner",
  "Fiona Kelly",
  "Gabe Lopez",
  "Greta Olsen",
  "Hana Kim",
  "Hugo Leroy",
  "Ines Silva",
  "Ivan Horvat",
  "Jade Wong",
  "Jonas Weber",
  "Julia Costa",
  "Kai Muller",
  "Lena Fischer",
  "Leo Bianchi",
  "Lucy Grant",
  "Mateo Diaz",
  "Mia Laurent",
  "Nadia Benali",
  "Noah Price",
  "Olga Kuznetsova",
  "Omar Khalil",
  "Paula Gomez",
  "Priya Nair",
  "Quinn Hayes",
  "Rafael Souza",
  "Rosa Medina",
  "Sam Ortiz",
  "Tara Quinn",
  "Tom Becker",
  "Uma Rao",
  "Wen Li",
  "Yara Nasser",
].map((name) => person(name));

/** Acme Freight's members, in the order they joined: 55, so a page of 50 leaves five. */
export const MEMBERS: Person[] = [
  DANA,
  ...OTHERS.slice(0, 10),
  SARAH,
  ...OTHERS.slice(10, 30),
  SARA,
  ...OTHERS.slice(30),
  SARITA,
];

/** People of another organization on the same OpenBot. Acme's screens never see them. */
export const OUTSIDERS: Person[] = [
  person("Sarai Fremont", "harbor.test"),
  person("Sarah Outsider", "harbor.test"),
];

/** Addresses Acme Freight invited: 55 still listed, three of them holding "sar". */
export const INVITED: string[] = [
  ...OTHERS.map((name) => name.email.replace("acme.test", "northwind.example")),
  "sarah.okafor@northwind.example",
  "sara.berg@northwind.example",
  "sarita.mendes@northwind.example",
  "kim.lee@northwind.example",
];

const team = (id: string, name: string, rest: Partial<Team> = {}): Team => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  memberCount: 0,
  role: null,
  canManage: true,
  canMove: true,
  canDelete: true,
  createdAt: "2026-11-15T09:12:40.000Z",
  ...rest,
});

const FUNCTIONS = [
  "Sales",
  "Support",
  "Finance",
  "Legal",
  "Marketing",
  "Design",
  "Operations",
  "Research",
  "Hiring",
  "Security",
  "Platform",
];
const REGIONS = ["EMEA", "APAC", "Americas", "Nordics", "Iberia"];

/** The team whose people are listed: every member of Acme, Dana its maintainer. */
export const SALES_EMEA = "team_sales_emea";
/** A small team to add people to: Dana and Sarah are in it. */
export const SUPPORT_NORDICS = "team_support_nordics";

/** Acme's teams, in the order they were created: 58, three of them holding "sar". */
export const TEAMS: Team[] = [
  ...FUNCTIONS.flatMap((fn) =>
    REGIONS.map((region) =>
      team(`team_${fn}_${region}`.toLowerCase(), `${fn} ${region}`),
    ),
  ),
  team("team_sarasota", "Sarasota office", {
    description: "Everybody at the Florida desk.",
  }),
  team("team_sarajevo", "Sarajevo desk", { parentTeamId: SALES_EMEA }),
  team("team_launch", "Sarah's launch crew"),
].map((one) => {
  const people = teamPeople()[one.id] ?? [];
  const mine = people.find((member) => member.id === DANA.id);
  return {
    ...one,
    memberCount: people.length,
    role: mine ? mine.role : null,
  };
});

function teamPeople(): Record<string, TeamMember[]> {
  const member = (who: Person, role: TeamMember["role"]): TeamMember => ({
    id: who.id,
    email: who.email,
    name: who.name,
    image: null,
    role,
    isCaller: who.id === DANA.id,
    joinedAt: "2026-11-15T09:13:02.000Z",
  });
  return {
    [SALES_EMEA]: MEMBERS.map((who) =>
      member(who, who === DANA ? "maintainer" : "member"),
    ),
    [SUPPORT_NORDICS]: [member(DANA, "maintainer"), member(SARAH, "member")],
  };
}

/** A Bot of Dana's, published to Sarah. */
export const PUBLISHED: TeamBot = teamBotOf("expenses", "Expenses", {
  title: "Finance",
  roleDescription: "Receipts.",
  audience: "people",
  people: [SARAH.email],
  teams: [],
});

export const BOT = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private" as const,
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** A group conversation Dana started, with Sarah in it. */
export const GROUP = "grp";
const GROUP_PEOPLE: GroupFixture["people"] = [
  { userId: DANA.id, email: DANA.email, name: DANA.name, creator: true },
  { userId: SARAH.id, email: SARAH.email, name: SARAH.name, creator: false },
];

/** The API's 400, as problem details. */
function invalid(detail: string): Response {
  return Response.json(
    {
      type: "https://open.bot/errors/validation-error",
      title: "Request validation failed.",
      status: 400,
      detail,
      code: "VALIDATION_ERROR",
    },
    { status: 400, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * One page of `items` as the API pages a list: `limit` (default 50, at most 100), a cursor bound to
 * the list and the search, and nextCursor null on the last page.
 */
function paged<T>(
  list: string,
  query: URLSearchParams,
  items: readonly T[],
  key: string,
  extra: Record<string, unknown> = {},
): Response {
  const limit = Number(query.get("limit") ?? "50");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return invalid("limit must be from 1 to 100.");
  const search = (query.get("search") ?? "").trim().toLowerCase();
  if (search.length > 200) return invalid("search is at most 200 long.");
  let start = 0;
  const cursor = query.get("cursor");
  if (cursor !== null) {
    let bound: { list?: string; search?: string; at?: number };
    try {
      bound = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      return invalid("That cursor isn't one this list gave out.");
    }
    if (
      bound.list !== list ||
      bound.search !== search ||
      typeof bound.at !== "number"
    )
      return invalid("That cursor isn't one this list gave out.");
    start = bound.at;
  }
  const end = start + limit;
  const nextCursor =
    end < items.length
      ? Buffer.from(JSON.stringify({ list, search, at: end })).toString(
          "base64url",
        )
      : null;
  return Response.json({
    [key]: items.slice(start, end),
    ...extra,
    nextCursor,
  });
}

/** Whether `text` holds what was searched for, ignoring case. */
function holds(search: string, ...texts: (string | null)[]): boolean {
  return texts.some((text) => text?.toLowerCase().includes(search));
}

/** The members' search: a name, a word of it or an address starting with it first, then any that hold it. */
function rankedMembers(people: readonly Person[], search: string): Person[] {
  if (!search) return [...people];
  const rank = (one: Person) => {
    const name = one.name.toLowerCase();
    const email = one.email.toLowerCase();
    if (
      name.startsWith(search) ||
      name.includes(` ${search}`) ||
      email.startsWith(search)
    )
      return 0;
    return holds(search, name, email) ? 1 : 2;
  };
  return people
    .map((one, index) => ({ one, index, rank: rank(one) }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.one);
}

function memberBody(one: Person): OrganizationMember {
  const isDana = one === DANA;
  return {
    id: one.id,
    email: one.email,
    name: one.name,
    image: null,
    role: isDana ? "admin" : "member",
    joinedAt: "2026-11-01T09:00:00.000Z",
    removable: !isDana,
    assignableRoles: isDana ? [] : ["admin"],
  };
}

function invitationBody(email: string, index: number): OrganizationInvitation {
  return {
    id: `inv_${index}`,
    email,
    role: "member",
    status: index % 9 === 4 ? "expired" : "pending",
    invitedBy: { name: DANA.name, email: DANA.email },
    createdAt: "2026-11-20T09:00:00.000Z",
    expiresAt: "2026-11-27T09:00:00.000Z",
  };
}

/** What the API answers one request with, or undefined for an address these screens never ask. */
export function answer(
  method: string,
  url: URL,
  body: unknown,
): Response | undefined {
  const path = url.pathname;
  const query = url.searchParams;
  const search = (query.get("search") ?? "").trim().toLowerCase();

  if (method === "GET") {
    if (path === `${ORGANIZATION}/deployment`)
      return Response.json({
        generativeUi: true,
        selfHostBanner: false,
        localEvaluation: false,
        edition: "team",
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
      });
    if (path === `${ORGANIZATION}/people/me`)
      return meResponse({ user: { ...DANA, role: "admin" } });
    if (path === "/api/v2/people/me/organizations")
      return Response.json({
        organizations: [
          {
            id: "default",
            slug: "acme",
            name: "Acme Freight",
            role: "admin",
            personal: false,
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      });
    if (path === `${ORGANIZATION}/members`)
      return paged(
        "members",
        query,
        rankedMembers(MEMBERS, search).map(memberBody),
        "members",
      );
    if (path === `${OTHER_ORGANIZATION}/members`)
      return paged(
        "harbor-members",
        query,
        rankedMembers(OUTSIDERS, search).map(memberBody),
        "members",
      );
    // Admin's People: the people who signed in to this organization.
    if (path === `${ORGANIZATION}/people`)
      return paged(
        "people",
        query,
        MEMBERS.filter((one) => holds(search, one.name, one.email)).map(
          (one) => ({
            id: one.id,
            email: one.email,
            name: one.name,
            image: null,
            role: one === DANA ? "admin" : "member",
            providers: ["google"],
            lastSignedInAt: "2026-11-22T09:00:00.000Z",
            revoked: false,
            configuredAdmin: false,
          }),
        ),
        "people",
      );
    if (path === `${ORGANIZATION}/invitations`)
      return paged(
        "invitations",
        query,
        INVITED.map(invitationBody).filter((one) => holds(search, one.email)),
        "invitations",
      );
    if (path === `${ORGANIZATION}/teams`)
      return paged(
        "teams",
        query,
        TEAMS.filter((one) => holds(search, one.name)),
        "teams",
        { canCreate: true },
      );
    const teamMembers = /\/teams\/([^/]+)\/members$/.exec(path);
    if (teamMembers?.[1] && path.startsWith(ORGANIZATION)) {
      if (!TEAMS.some((one) => one.id === teamMembers[1])) return undefined;
      return paged(
        `team-members:${teamMembers[1]}`,
        query,
        (teamPeople()[teamMembers[1]] ?? []).filter((one) =>
          holds(search, one.name, one.email),
        ),
        "members",
      );
    }
    const oneTeam = /\/teams\/([^/]+)$/.exec(path);
    if (oneTeam && path.startsWith(ORGANIZATION)) {
      const found = TEAMS.find((one) => one.id === oneTeam[1]);
      return found ? Response.json({ team: found }) : undefined;
    }
    if (path === `${ORGANIZATION}/team-bots`)
      return Response.json({ teamBots: [PUBLISHED], nextCursor: null });
    if (path === `${ORGANIZATION}/bots/expenses`)
      return Response.json({ bot: BOT });
    if (path.includes("/shared-use/bot/")) return Response.json({ apps: [] });
    if (path.includes("/shared-use")) return Response.json({ requests: [] });
    return answerGroupRead(url, { method }, GROUP, {
      bots: [],
      people: GROUP_PEOPLE,
      messages: [],
    });
  }

  // Adding somebody to a team: the person, in the team with the role asked for.
  const added = /\/teams\/[^/]+\/members\/([^/]+)$/.exec(path);
  if (method === "PUT" && added) {
    const who = MEMBERS.find((one) => one.id === added[1]);
    if (!who) return undefined;
    return Response.json({
      member: {
        ...who,
        image: null,
        role: (body as { role?: string } | undefined)?.role ?? "member",
        isCaller: who === DANA,
        joinedAt: "2026-11-23T09:00:00.000Z",
      },
    });
  }
  if (
    method === "POST" &&
    path === `${ORGANIZATION}/conversations/${GROUP}/members`
  ) {
    const email = (body as { email?: string } | undefined)?.email;
    const who = MEMBERS.find((one) => one.email === email);
    return who
      ? Response.json({ personId: who.id }, { status: 201 })
      : invalid("Nobody with that address has signed in here.");
  }
  if (method === "PUT" && path === `${ORGANIZATION}/team-bots/expenses`)
    return Response.json({
      teamBot: { ...PUBLISHED, ...(body as object) },
      sharedApps: { approved: [], needsApproval: [] },
    });
  return undefined;
}
