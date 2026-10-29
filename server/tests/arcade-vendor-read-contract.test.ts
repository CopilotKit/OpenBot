// server/tests/arcade-vendor-read-contract.test.ts
/**
 * HOW EVERY ARCADE VENDOR-FIELD READER TREATS A VALUE IT CANNOT READ — one row per reader × shape.
 *
 * The class this guards is K2: a reader on an AUTHORIZATION decision that fails OPEN. C2 gave the
 * `requirements.authorization` block one tri-state reading, `authorizationRequirementOf` —
 * `none | unreadable(field, shape) | required` — and C2b held `authProvidersNamedBy` to it. The
 * sibling readers never got it: each picked its own default for a field it could not read, and
 * the default it picked was the permissive one. A missing `token_status` reads as authorized (A7c),
 * an unreadable scopes block reads as "the connection is the grant" (C2c), a `connection_status`
 * that is present but not text reads as live (A7b), and the mint's allowlist test could not fail
 * on a missing `.trim().toLowerCase()` (D6). The tests never presented the shapes that show it.
 *
 * THE RULE THE TABLE STATES — the one `vendorStatusOf` / `requiredScopesOf` /
 * `authorizationRequirementOf` in `server/src/plugins/arcade.ts` implement. Absent (`missing`,
 * `undefined`, `null`) reads as the field's documented default. A value that is PRESENT BUT NOT THE
 * SHAPE THE FIELD HAS is unreadable, and unreadable FAILS CLOSED: the grants screen says `unknown`,
 * a listing refuses, a connection is not live, a mint is refused. Never authorized, never live,
 * never `[]`-as-grant, never a redirect.
 *
 * TWO READINGS THIS TABLE ONCE HELD APART, SETTLED (K2). `null` is ABSENCE on every field — C2's
 * reading, which the vendor's own `requirements: null` evidences — so `connection_status: null` is
 * live like a missing one, not "a value sent" (the A7b row that said otherwise is withdrawn). And a
 * BLANK STRING is UNREADABLE on every decision field — C2b's reading of a blank `provider_id` — so
 * `connection_status: ""` is not live (the source's "absent or empty reads as live" is withdrawn).
 *
 * EACH ROW IS DRIVEN THROUGH THE READER'S PUBLIC DOOR — `broker.grantsFor`, `broker.listApps`,
 * the transport's `listTools`, `broker.isConnected`, `broker.authorize` — over SDK prototype
 * stubs, so nothing here needs a production export and the verdict is the one a caller sees.
 *
 * ROWS ARE KEYED `reader · field · shape`, never `path:line`. The reader is a binding name checked
 * below to still exist in its file; the field is the vendor's own path. Neither moves when
 * somebody rewraps a comment, which is the collision a line-keyed list has had three waves running.
 *
 * KNOWN-WRONG ROWS ARE DEBT, NOT SPECIFICATION — the discipline of `typecheck-baseline.txt`.
 * Every row's `want` is the RIGHT answer. Where production answers something else today, the row
 * is listed in {@link KNOWN_FAIL_OPEN} with what it answers NOW and the finding that owns it. The
 * check is equality both ways: an enforced row must answer `want`; a debt row must answer exactly
 * its recorded `now` — so it can neither drift to a third answer unseen nor be FIXED without its
 * entry being deleted. Fixing a reader and deleting its entries is always correct. ADDING an entry
 * is not: a new entry means a reader that fails open was written today, and the gate exists to
 * say so. Editing a `want` to match what production does is the one move this file forbids.
 */
import { afterEach, describe, expect, test } from "bun:test";
import Arcade from "@arcadeai/arcadejs";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

// ---------------------------------------------------------------------------------------------
// Harness: SDK prototype stubs, installed BEFORE construction; `new Arcade({ apiKey })` dials
// nothing.
// ---------------------------------------------------------------------------------------------

type Methods = Record<string, (...args: unknown[]) => unknown>;
const protoOf = (pick: (c: Arcade) => unknown): Methods =>
  Object.getPrototypeOf(
    pick(new Arcade({ apiKey: "never-dialled" })),
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  pick: (c: Arcade) => unknown,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const on = protoOf(pick);
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
  useArcadeClient(null);
});

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/**
 * What a call answered, or the fact that it refused.
 *
 * A CRASH IS NOT A REFUSAL. A `TypeError` off a hole the reader dereferenced is reported as
 * `crashes`, so a row whose right answer is `refuses` cannot be satisfied by the reader falling
 * over — nor by this harness doing so.
 */
async function settle<T>(
  run: () => Promise<T>,
  read: (value: T) => string,
): Promise<string> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    return error instanceof TypeError || error instanceof ReferenceError
      ? `crashes: ${(error as Error).message}`
      : "refuses";
  }
  return read(value);
}

// ---------------------------------------------------------------------------------------------
// The shapes. `missing` deletes the key; every other shape sets it.
// ---------------------------------------------------------------------------------------------

const MISSING = Symbol("missing");
const SHAPES: { label: string; value: unknown }[] = [
  { label: "missing", value: MISSING },
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "{}", value: {} },
  { label: "false", value: false },
  { label: "0", value: 0 },
  { label: "[]", value: [] },
  { label: '""', value: "" },
];

/** `base` with `value` placed at `path` (or the last key deleted, for `MISSING`). */
function placed(
  base: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const root = structuredClone(base);
  let at = root;
  for (const key of path.slice(0, -1)) {
    at = at[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === MISSING) delete at[last];
  else at[last] = value;
  return root;
}

// ---------------------------------------------------------------------------------------------
// The readers, each through its public door. `observe` turns a vendor value at the reader's field
// into a VERDICT string; the vocabulary is per reader and spelled out on each.
// ---------------------------------------------------------------------------------------------

type Reader = {
  /** The binding that does the read — checked below to still be defined in `file`. */
  name: string;
  file: "server/src/plugins/arcade-adapter.ts" | "server/src/plugins/arcade.ts";
  /** The door the verdict is read through. */
  door: string;
  observe: (edit: Edit) => Promise<string>;
};

/** What a row does to the reader's base object: place one hostile value (and maybe a neighbour). */
type Edit = (base: Record<string, unknown>) => Record<string, unknown>;

/** A grant read as `<state> [<scopes>]`, or `unknown`/`needs-operator`, or `refuses`. */
function grantVerdict(grants: { state: string; scopes?: string[] }[]): string {
  if (grants.length !== 1) return `${grants.length} grants`;
  const [grant] = grants;
  return grant.scopes === undefined
    ? grant.state
    : `${grant.state} [${grant.scopes.join(",")}]`;
}

/** The listing row the grants and catalogue readers see, with a held, scoped authorization. */
const LISTED = {
  qualified_name: "Github.SetStarred",
  fully_qualified_name: "Github.SetStarred@1.0.0",
  name: "SetStarred",
  toolkit: { name: "Github", description: "" },
  metadata: { behavior: { read_only: true, destructive: false } },
  requirements: {
    met: true,
    secrets: [],
    authorization: {
      provider_id: "github",
      status: "active",
      token_status: "completed",
      oauth2: { scopes: ["repo"] },
    },
  },
};

const GRANT_STATE_OF: Reader = {
  name: "grantStateOf",
  file: "server/src/plugins/arcade-adapter.ts",
  door: "broker.grantsFor",
  observe: (edit) => {
    const item = edit(LISTED);
    stub(
      (c) => c.tools,
      "list",
      () => Promise.resolve({ items: [item] }),
    );
    return settle(
      () =>
        createArcadeClient("never-dialled").broker.grantsFor({
          toolkit: "Github",
          account,
        }),
      grantVerdict,
    );
  },
};

/** The one app's scope standing: `scoped` / `unscoped`, or `refuses`. */
const CATALOGUE_SCOPES_OF: Reader = {
  name: "scopesOf",
  file: "server/src/plugins/arcade-adapter.ts",
  door: "broker.listApps",
  observe: (edit) => {
    const item = edit(LISTED);
    stub(
      (c) => c.tools,
      "list",
      () => Promise.resolve({ items: [item], total_count: 1 }),
    );
    return settle(
      () => createArcadeClient("never-dialled").broker.listApps(),
      (apps) => {
        if (apps.length !== 1) return `${apps.length} apps`;
        return (apps[0].scopedActionCount ?? 0) > 0 ? "scoped" : "unscoped";
      },
    );
  },
};

/** The listed tool's `scopes` as `scopes [<scopes>]`, or `refuses`. */
const TRANSPORT_SCOPES_OF: Reader = {
  name: "scopesOf",
  file: "server/src/plugins/arcade.ts",
  door: "listTools",
  observe: (edit) => {
    const item = edit(LISTED);
    useArcadeClient({
      listTools: () => Promise.resolve({ items: [item] }),
      execute: () => Promise.reject(new Error("not under test")),
    });
    return settle(
      () => listTools({ url: "arcade://Github" }),
      (tools) =>
        tools.length === 1
          ? `scopes [${tools[0].scopes.join(",")}]`
          : `${tools.length} tools`,
    );
  },
};

/** The connection: `live` / `not-live`, or `refuses`. */
const CONNECTION_IS_LIVE: Reader = {
  name: "connectionIsLive",
  file: "server/src/plugins/arcade-adapter.ts",
  door: "broker.isConnected",
  observe: (edit) => {
    const row = edit({
      id: "at_1",
      connection_id: "ac_1",
      provider_id: "cpk-poc",
      connection_status: "active",
      provider_user_info: { name: "Ada" },
    });
    stub(
      (c) => c.tools,
      "list",
      () =>
        Promise.resolve({
          items: [
            {
              qualified_name: "Github.A",
              requirements: { authorization: { provider_id: "github" } },
            },
          ],
          total_count: 1,
        }),
    );
    stub(
      (c) => c.admin.authProviders,
      "list",
      () =>
        Promise.resolve({
          items: [{ id: "cpk-poc", provider_id: "github" }],
          total_count: 1,
        }),
    );
    stub(
      (c) => c.admin.userConnections,
      "list",
      (query) =>
        Promise.resolve(
          (query as { user_id?: unknown }).user_id === account.vendorUserId
            ? { items: [row], total_count: 1 }
            : { items: [], total_count: 0 },
        ),
    );
    return settle(
      () =>
        createArcadeClient("never-dialled").broker.isConnected({
          account,
          toolkit: "Github",
        }),
      (live) => (live ? "live" : "not-live"),
    );
  },
};

/** The mint: `consent-next` when handed on, `refuses: already` for a held grant, else `refuses`. */
const MINT_STATUS: Reader = {
  name: "MINT_AWAITS_CONSENT_STATUSES",
  file: "server/src/plugins/arcade-adapter.ts",
  door: "broker.authorize",
  observe: async (edit) => {
    const answer = edit({
      id: "ar_mint1",
      url: "https://consent.example/go",
      status: "pending",
    });
    stub(
      (c) => c.tools,
      "authorize",
      () => Promise.resolve(answer),
    );
    try {
      const minted = await createArcadeClient("never-dialled").broker.authorize(
        {
          account,
          toolkit: "Gmail",
          action: "Gmail.SendEmail",
          returnUrl: "https://openbot.example/settings/plugins",
        },
      );
      return minted.redirectUrl === "https://consent.example/go"
        ? "consent-next"
        : "handed on elsewhere";
    } catch (error) {
      if (error instanceof TypeError) return `crashes: ${error.message}`;
      return /already/i.test(String((error as Error).message))
        ? "refuses: already"
        : "refuses";
    }
  },
};

// ---------------------------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------------------------

type Row = {
  reader: Reader;
  /** The vendor field the reader reads, as a path from the object the door hands it. */
  field: string[];
  /** The shape label, or for a normalization row the quoted text. */
  shape: string;
  value: unknown;
  /** A neighbouring field set first, so a fallback through it cannot answer the row. */
  beside?: { path: string[]; value: unknown };
  /** THE RIGHT ANSWER. Never edited to match production; see the header. */
  want: string;
  why: string;
};

const keyOf = (row: Row): string =>
  `${row.reader.name} (${row.reader.file.split("/").pop()}) · ${row.field.join(".")} · ${row.shape}`;

/** Absent → `absent`; the rest → `unreadable`. Labels as {@link SHAPES} spells them. */
function sweep(
  reader: Reader,
  field: string[],
  answers: {
    absent: string;
    unreadable: string;
    /** Shapes that are READABLE at this field and so answer `absent`, not `unreadable`. */
    readableAsAbsent?: string[];
  },
  why: string,
): Row[] {
  const absentShapes = new Set([
    "missing",
    "undefined",
    "null",
    ...(answers.readableAsAbsent ?? []),
  ]);
  return SHAPES.map(({ label, value }) => ({
    reader,
    field,
    shape: label,
    value,
    want: absentShapes.has(label) ? answers.absent : answers.unreadable,
    why,
  }));
}

const AUTH = ["requirements", "authorization"];
const BESIDE_INACTIVE = '" Completed " beside status "inactive"';

const ROWS: Row[] = [
  // grantStateOf — token_status, beside `status: "active"` (the fallback A7c names). `status` is
  // the auth PROVIDER's standing, not this account's grant, so no token_status is no answer.
  ...sweep(
    GRANT_STATE_OF,
    [...AUTH, "token_status"],
    { absent: "unknown", unreadable: "unknown" },
    "what this account holds is token_status; nothing readable there is not a grant",
  ),
  // grantStateOf — the scopes the grant covers, beside `token_status: "completed"`.
  ...sweep(
    GRANT_STATE_OF,
    [...AUTH, "oauth2", "scopes"],
    {
      absent: "authorized []",
      unreadable: "unknown",
      readableAsAbsent: ["[]"],
    },
    "an unreadable scope list is not 'the connection is the grant'",
  ),
  ...sweep(
    GRANT_STATE_OF,
    [...AUTH, "oauth2"],
    {
      absent: "authorized []",
      unreadable: "unknown",
      readableAsAbsent: ["{}"],
    },
    "an oauth2 block that is not an object is not 'no scopes'",
  ),
  // scopesOf (adapter) — feeds listApps' scopedActionCount/permissionCount.
  ...sweep(
    CATALOGUE_SCOPES_OF,
    [...AUTH, "oauth2", "scopes"],
    { absent: "unscoped", unreadable: "refuses", readableAsAbsent: ["[]"] },
    "the catalogue refuses what it cannot read, as requiresAuthorization already does",
  ),
  ...sweep(
    CATALOGUE_SCOPES_OF,
    [...AUTH, "oauth2"],
    { absent: "unscoped", unreadable: "refuses", readableAsAbsent: ["{}"] },
    "the catalogue refuses what it cannot read, as requiresAuthorization already does",
  ),
  // scopesOf (arcade.ts) — the tool `scopes` the gate reads; `[]` there means "connection is the
  // grant", so an unreadable block must not become it.
  ...sweep(
    TRANSPORT_SCOPES_OF,
    AUTH,
    { absent: "scopes []", unreadable: "refuses", readableAsAbsent: ["{}"] },
    "authorizationRequirementOf's reading: absent is none, a non-object is unreadable",
  ),
  ...sweep(
    TRANSPORT_SCOPES_OF,
    [...AUTH, "oauth2"],
    { absent: "scopes []", unreadable: "refuses", readableAsAbsent: ["{}"] },
    "an oauth2 block that is not an object is not 'no scopes'",
  ),
  ...sweep(
    TRANSPORT_SCOPES_OF,
    [...AUTH, "oauth2", "scopes"],
    { absent: "scopes []", unreadable: "refuses", readableAsAbsent: ["[]"] },
    "an unreadable scope list is not 'the connection is the grant'",
  ),
  // connectionIsLive — absent is live ("silence is not a no", documented in the source, and so is
  // an empty string); present but not text is the vendor saying something this cannot read.
  // `null` is absence here as on every field, and a blank string is unreadable as on every
  // decision field — see the header's "settled".
  ...sweep(
    CONNECTION_IS_LIVE,
    ["connection_status"],
    { absent: "live", unreadable: "not-live" },
    "present but not text (or blank) is not 'no status'",
  ),
  // The mint's own `status` (L2-b): absent is silence and the url stands; anything present that is
  // not status text is NOT handed to a browser as a live redirect.
  ...sweep(
    MINT_STATUS,
    ["status"],
    { absent: "consent-next", unreadable: "refuses" },
    "a bearer url beside a status nobody could read is not a consent screen to send somebody to",
  ),
  // A scope list holding something that is not a scope is not the narrower list without it.
  ...(
    [
      [GRANT_STATE_OF, "unknown"],
      [CATALOGUE_SCOPES_OF, "refuses"],
      [TRANSPORT_SCOPES_OF, "refuses"],
    ] as const
  ).flatMap(([reader, want]) =>
    (
      [
        ['["repo",5]', ["repo", 5]],
        ['["repo",""]', ["repo", ""]],
        ['["repo",null]', ["repo", null]],
      ] as const
    ).map(
      ([shape, value]): Row => ({
        reader,
        field: [...AUTH, "oauth2", "scopes"],
        shape,
        value,
        want,
        why: "a partly unreadable scope list read as the readable part is a narrower grant than the one described",
      }),
    ),
  ),

  // Readable controls: the reader still READS. Without these a reader that answered the
  // permissive default for everything would pass every absent row above.
  ...(
    [
      [
        GRANT_STATE_OF,
        [...AUTH, "oauth2", "scopes"],
        ["repo"],
        "authorized [repo]",
      ],
      [
        GRANT_STATE_OF,
        [...AUTH, "token_status"],
        "pending",
        "needs-consent [repo]",
      ],
      [CATALOGUE_SCOPES_OF, [...AUTH, "oauth2", "scopes"], ["repo"], "scoped"],
      [
        TRANSPORT_SCOPES_OF,
        [...AUTH, "oauth2", "scopes"],
        ["repo"],
        "scopes [repo]",
      ],
      [CONNECTION_IS_LIVE, ["connection_status"], "active", "live"],
      [MINT_STATUS, ["status"], "pending", "consent-next"],
    ] as const
  ).map(
    ([reader, field, value, want]): Row => ({
      reader,
      field: [...field],
      shape: `readable ${JSON.stringify(value)}`,
      value,
      want,
      why: "a positive control: the readable value is still read",
    }),
  ),

  // Normalization: case, whitespace, and every allowlist member.
  {
    reader: GRANT_STATE_OF,
    field: [...AUTH, "token_status"],
    shape: BESIDE_INACTIVE,
    value: " Completed ",
    beside: { path: [...AUTH, "status"], value: "inactive" },
    want: "authorized [repo]",
    why: "a case or a space the vendor changes must not change an answer about an account",
  },
  {
    reader: GRANT_STATE_OF,
    field: [...AUTH, "token_status"],
    shape: '"NOT_STARTED"',
    value: "NOT_STARTED",
    want: "needs-consent [repo]",
    why: "a case or a space the vendor changes must not change an answer about an account",
  },
  {
    reader: CONNECTION_IS_LIVE,
    field: ["connection_status"],
    shape: '" ACTIVE "',
    value: " ACTIVE ",
    want: "live",
    why: "folded and trimmed",
  },
  {
    reader: CONNECTION_IS_LIVE,
    field: ["connection_status"],
    shape: '"Expired"',
    value: "Expired",
    want: "not-live",
    why: "an allowlist: any spelling but the live one is not live",
  },
  {
    reader: MINT_STATUS,
    field: ["status"],
    shape: '"not_started"',
    value: "not_started",
    want: "consent-next",
    why: "half the allowlist, and the one a first-time mint answers (D6)",
  },
  {
    reader: MINT_STATUS,
    field: ["status"],
    shape: '"  Pending "',
    value: "  Pending ",
    want: "consent-next",
    why: "the only status row that FAILS when the trim/lowercase is deleted (D6)",
  },
  {
    reader: MINT_STATUS,
    field: ["status"],
    shape: '" NOT_STARTED "',
    value: " NOT_STARTED ",
    want: "consent-next",
    why: "folded and trimmed, on the other allowlist member (D6)",
  },
  {
    reader: MINT_STATUS,
    field: ["status"],
    shape: '"  Completed "',
    value: "  Completed ",
    want: "refuses: already",
    why: "the held-grant sentence, which only a normalized read reaches (D6)",
  },
];

// ---------------------------------------------------------------------------------------------
// THE DEBT. Delete an entry when its reader is fixed; never add one. See the header.
// ---------------------------------------------------------------------------------------------

/**
 * EMPTY SINCE K2: the 43 entries L2 recorded (A7c ×10, C2c ×28, A7b ×5) were paid by giving every
 * reader the one reading in `server/src/plugins/arcade.ts`. An entry added here is a reader that
 * fails open written after that, which is what this gate exists to say.
 */
const KNOWN_FAIL_OPEN: Record<string, { now: string; finding: string }> = {};

// ---------------------------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------------------------

describe("a vendor field this deployment cannot read fails closed", () => {
  for (const row of ROWS) {
    const key = keyOf(row);
    const debt = KNOWN_FAIL_OPEN[key];
    const label = debt
      ? `[debt ${debt.finding.split(":")[0]}] ${key} — answers ${debt.now}, should answer ${row.want}`
      : `${key} → ${row.want} (via ${row.reader.door})`;
    test(label, async () => {
      const observed = await row.reader.observe((base) =>
        placed(
          row.beside ? placed(base, row.beside.path, row.beside.value) : base,
          row.field,
          row.value,
        ),
      );
      const expected = debt ? debt.now : row.want;
      const diagnosis =
        observed === expected
          ? "as recorded"
          : debt && observed === row.want
            ? "FIXED: delete this row's KNOWN_FAIL_OPEN entry"
            : debt
              ? "debt changed to a third answer"
              : "differs from the right answer";
      expect({ key, observed, diagnosis }).toEqual({
        key,
        observed: expected,
        diagnosis: "as recorded",
      });
    });
  }
});
