/**
 * A Bot's settings on the phone decide who may change what from the server's verdicts on the Bot, and
 * send the same requests as the web app's Bot pages: the whole profile with only what changed besides,
 * never a key, never a level this app doesn't know.
 */
import { expect, test } from "bun:test";
import type {
  Bot,
  BotResetCounts,
  ModelCatalogue,
} from "../src/api/generated/model";
import {
  assignChoices,
  assignmentName,
  audienceSummary,
  botUpdate,
  checkSetup,
  chosenModel,
  defaultModelSummary,
  handoffGrantId,
  handoffRoster,
  isAdmin,
  isNotifyLevel,
  isolationRow,
  isPhoneNumber,
  isVerificationCode,
  manageOffer,
  mayChangeVisibility,
  mayOpenSharing,
  maySetUp,
  modelGroups,
  notifyLabel,
  publication,
  publishedTo,
  reachSummary,
  resetLines,
  setupDraftOf,
  setupRequest,
  sharingSummary,
  visibilityChoices,
} from "../src/bot-settings";

const bot = (change: Partial<Bot> = {}): Bot => ({
  id: "b1",
  name: "Ada",
  title: "Research",
  roleDescription: "Reads the news.",
  avatarSeed: "b1",
  visibility: "private",
  hidden: false,
  pinned: false,
  systemOwned: false,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  canManage: true,
  mine: true,
  assignedToMe: false,
  builtIn: true,
  runsOnOpenBotModel: true,
  keyFromOpenBot: true,
  isolationActive: false,
  isolationOffReason: null,
  ...change,
});

test("an owner or an admin runs the organization; a role the app doesn't know is a member", () => {
  expect(isAdmin("owner")).toBe(true);
  expect(isAdmin("admin")).toBe(true);
  expect(isAdmin("member")).toBe(false);
  expect(isAdmin("auditor")).toBe(false);
  expect(isAdmin(undefined)).toBe(false);
});

test("Setup is editable only where the server says the person may manage the Bot", () => {
  expect(maySetUp(bot())).toBe(true);
  expect(maySetUp(bot({ canManage: false, mine: true }))).toBe(false);
});

test("Sharing is offered to the owner, a manager or an admin, and never in the personal edition", () => {
  const team = { personal: false, admin: false };
  expect(mayOpenSharing(bot(), team)).toBe(true);
  expect(mayOpenSharing(bot({ mine: false, canManage: false }), team)).toBe(
    false,
  );
  expect(
    mayOpenSharing(bot({ mine: false, canManage: false }), {
      personal: false,
      admin: true,
    }),
  ).toBe(true);
  expect(mayOpenSharing(bot(), { personal: true, admin: true })).toBe(false);
});

test("who can use a Bot is changed by its manager, never on one that comes with OpenBot", () => {
  expect(mayChangeVisibility(bot())).toBe(true);
  expect(mayChangeVisibility(bot({ canManage: false }))).toBe(false);
  expect(mayChangeVisibility(bot({ systemOwned: true }))).toBe(false);
});

test("an assigned Bot stays pinned and can't be hidden; Delete only for a manager", () => {
  expect(manageOffer(bot())).toEqual({ assigned: false, canDelete: true });
  expect(manageOffer(bot({ assignedToMe: true, canManage: false }))).toEqual({
    assigned: true,
    canDelete: false,
  });
  expect(manageOffer(bot({ systemOwned: true })).canDelete).toBe(false);
});

test("a change sends the stored profile with only what changed, and never the address unasked", () => {
  expect(botUpdate(bot(), { visibility: "public" })).toEqual({
    name: "Ada",
    title: "Research",
    roleDescription: "Reads the news.",
    visibility: "public",
  });
  expect(botUpdate(bot(), { isolated: true })).toEqual({
    name: "Ada",
    title: "Research",
    roleDescription: "Reads the news.",
    visibility: "private",
    isolated: true,
  });
  expect(botUpdate(bot(), { defaultModel: null }).defaultModel).toBeNull();
});

test("the form shows the starter's instructions and an outside Bot's address only where they exist", () => {
  expect(setupDraftOf(bot())).toEqual({
    name: "Ada",
    title: "Research",
    roleDescription: "Reads the news.",
  });
  expect(
    setupDraftOf(
      bot({
        instructions: "Be brief.",
        builtIn: false,
        endpoint: "https://agent.example.com",
      }),
    ),
  ).toMatchObject({
    instructions: "Be brief.",
    endpoint: "https://agent.example.com",
  });
});

test("the form is checked against the server's limits", () => {
  expect(
    checkSetup({ name: " ", title: "", roleDescription: "" }),
  ).toMatchObject({
    name: "Name is required.",
    roleDescription: "A description of what it does is required.",
  });
  expect(
    checkSetup({
      name: "x".repeat(81),
      title: "y".repeat(121),
      roleDescription: "ok",
      instructions: "",
      endpoint: "agent.example.com",
    }),
  ).toEqual({
    name: "Name must be 80 characters or fewer.",
    title: "Title must be 120 characters or fewer.",
    instructions: "Instructions are required.",
    endpoint: "Enter a web address starting with http:// or https://.",
  });
});

test("Save sends trimmed text, only what changed, and nothing when nothing did", () => {
  const stored = bot({
    builtIn: false,
    endpoint: "https://agent.example.com",
  });
  const draft = setupDraftOf(stored);
  expect(setupRequest(stored, draft).request).toBeNull();
  expect(setupRequest(stored, { ...draft, name: " Ada " }).request).toBeNull();
  expect(setupRequest(stored, { ...draft, name: "  Grace " }).request).toEqual({
    name: "Grace",
    title: "Research",
    roleDescription: "Reads the news.",
    visibility: "private",
  });
  expect(
    setupRequest(stored, { ...draft, endpoint: "https://new.example.com" })
      .request?.endpoint,
  ).toBe("https://new.example.com");
  const refused = setupRequest(stored, { ...draft, name: "" });
  expect(refused.request).toBeNull();
  expect(refused.errors.name).toBe("Name is required.");
});

test("the Isolated switch is offered where this OpenBot can make the computer, and turning it off always", () => {
  const offers = { isolatedBots: true };
  expect(isolationRow(bot(), offers)).toMatchObject({
    showSwitch: true,
    editable: true,
  });
  expect(isolationRow(bot(), { isolatedBots: false })).toMatchObject({
    editable: false,
    summary: "This OpenBot can't give a Bot a computer of its own.",
  });
  expect(
    isolationRow(bot(), { isolatedBots: false, hostedSignIn: true }).summary,
  ).toBe("OpenBot Cloud gives each person one computer, not one per Bot.");
  expect(
    isolationRow(bot({ isolated: true }), { isolatedBots: false }).editable,
  ).toBe(true);
  expect(
    isolationRow(bot({ isolated: true, isolationOffReason: "admin" }), offers)
      .summary,
  ).toBe(
    "Your admin turned off Isolated Bots, so this Bot runs on your computer.",
  );
  expect(isolationRow(bot({ canManage: false }), offers)).toMatchObject({
    showSwitch: false,
    editable: false,
  });
  expect(isolationRow(bot({ systemOwned: true }), offers).showSwitch).toBe(
    false,
  );
});

test("who can use it is said with the organization's name where it is known", () => {
  expect(visibilityChoices("Acme")[1]?.label).toBe("Everyone in Acme");
  expect(visibilityChoices()[1]?.label).toBe("Everyone in the organization");
});

test("the Sharing row says who it is published to, or who its visibility lets use it", () => {
  expect(sharingSummary(undefined, "public", "Acme")).toBe(
    "Everyone in Acme (public)",
  );
  expect(sharingSummary(undefined, "private")).toBe("Not shared");
  expect(sharingSummary({ audience: "team" }, "private")).toBe(
    "Everyone in the organization",
  );
  expect(sharingSummary({ audience: "people" }, "private")).toBe(
    "Specific people and teams",
  );
});

test("someone a Bot is published to finds Sharing too, outside the personal edition", () => {
  const stranger = bot({ mine: false, canManage: false });
  expect(
    mayOpenSharing(stranger, {
      personal: false,
      admin: false,
      published: true,
    }),
  ).toBe(true);
  expect(
    mayOpenSharing(stranger, { personal: true, admin: false, published: true }),
  ).toBe(false);
});

const teams = [
  { id: "t1", name: "Design" },
  { id: "t2", name: "Sales" },
];

test("who it is published to is said by name, and a team the list doesn't hold is counted", () => {
  expect(publishedTo({ audience: "team" }, teams)).toBe(
    "To everyone in the organization",
  );
  expect(
    publishedTo(
      {
        audience: "people",
        people: ["sam@acme.com"],
        teams: ["t1", "gone"],
        groups: ["eng"],
      },
      teams,
    ),
  ).toBe("To sam@acme.com, Design, 1 other team, group eng");
  expect(publishedTo({ audience: "people" }, teams)).toBe("To nobody yet");
  expect(
    audienceSummary(
      { audience: "people", people: ["a", "b"], teams: ["t1"] },
      false,
    ),
  ).toBe("2 people, 1 team");
  expect(audienceSummary(undefined, true)).toBe("Choose who to publish it to");
  expect(audienceSummary(undefined, false)).toBe("Not published");
});

test("publishing to everyone names nobody; named people keep the old directory groups", () => {
  const chosen = {
    emails: ["sam@acme.com"],
    teams: ["t1"],
    groups: ["eng"],
  };
  expect(publication({ audience: "team", ...chosen })).toEqual({
    audience: "team",
    emails: [],
    groups: [],
    teams: [],
  });
  expect(publication({ audience: "people", ...chosen })).toEqual({
    audience: "people",
    emails: ["sam@acme.com"],
    groups: ["eng"],
    teams: ["t1"],
  });
});

test("assignments are named, and what a Bot is assigned to already is not offered again", () => {
  expect(assignmentName("*", teams)).toBe("Everyone in the organization");
  expect(assignmentName("team:t2", teams)).toBe("Sales");
  expect(assignmentName("team:gone", teams)).toBe("A team that was deleted");
  expect(assignmentName("eng", teams)).toBe("Group eng");
  expect(assignChoices(["*", "team:t1"], teams)).toEqual([
    { value: "team:t2", label: "Sales" },
  ]);
});

test("Reaching you names each place once, and checks a phone and its code as the API does", () => {
  expect(reachSummary([])).toBe("Only in OpenBot");
  expect(reachSummary(["sms", "slack", "slack", "pager"])).toBe(
    "pager, Slack, SMS",
  );
  expect(isPhoneNumber(" +14155550123 ")).toBe(true);
  expect(isPhoneNumber("4155550123")).toBe(false);
  expect(isVerificationCode("123456")).toBe(true);
  expect(isVerificationCode("12a4")).toBe(false);
});

test("a notification level the app doesn't know reads as nothing and is never sent", () => {
  expect(notifyLabel("needs_input")).toBe("Only when it needs me");
  expect(notifyLabel("weekly")).toBe("");
  expect(isNotifyLevel("none")).toBe(true);
  expect(isNotifyLevel("weekly")).toBe(false);
});

test("hand-offs offer every other Bot, and a hidden one only while it is granted", () => {
  const listed = [
    { id: "b1", hidden: false },
    { id: "b2", hidden: false },
    { id: "b3", hidden: false },
  ];
  const hidden = [
    { id: "b4", hidden: true },
    { id: "b5", hidden: true },
  ];
  const open = handoffRoster({
    botId: "b1",
    roster: listed,
    hidden,
    handoff: { reachable: ["b2", "b4"], grantable: true },
  });
  expect(open.candidates.map((one) => one.id)).toEqual(["b2", "b3", "b4"]);
  expect([open.granted, open.total]).toEqual([2, 3]);
  const closed = handoffRoster({
    botId: "b1",
    roster: listed,
    hidden,
    handoff: { reachable: ["b2"], grantable: false },
  });
  expect(closed.candidates.map((one) => one.id)).toEqual(["b2"]);
  expect(handoffGrantId("b2")).toBe("bot:b2");
});

test("a reset lists only the kinds it would delete", () => {
  const counts: BotResetCounts = {
    conversations: 3,
    sharedConversationsKept: 1,
    memorySources: 0,
    memories: 1,
    routines: 0,
    responsibilities: 0,
    followUps: 2,
    formedMemories: 0,
    backgroundResearch: 0,
    standingApprovals: 0,
  };
  expect(resetLines(counts)).toEqual([
    "3 conversations",
    "1 imported memory",
    "2 scheduled follow-ups",
  ]);
});

const catalogue = (change: Partial<ModelCatalogue> = {}): ModelCatalogue =>
  ({
    provider: "openai",
    source: "openai",
    exposure: "allowed",
    default: "m1",
    models: [
      { id: "m1", label: "Model One" },
      { id: "m2", label: "Model Two" },
    ],
    choosable: true,
    listed: true,
    ...change,
  }) as ModelCatalogue;

test("with one connection a default model is saved with no source, and read back by the catalogue's", () => {
  const groups = modelGroups(catalogue());
  expect(groups).toHaveLength(1);
  expect(groups[0]?.choices[1]?.saved).toEqual({ model: "m2", effort: null });
  expect(
    chosenModel({ model: "m2", effort: null, source: "openai" }, catalogue())
      ?.label,
  ).toBe("Model Two");
  expect(defaultModelSummary(null, catalogue())).toBe(
    "OpenBot's default · Model One",
  );
  expect(
    defaultModelSummary(
      { model: "gone", effort: null, source: "openai" },
      catalogue(),
    ),
  ).toBe(
    "The chosen model isn't available. New conversations use OpenBot's default.",
  );
});

test("with several connections each ready one is a group, and a pick names its kind of connection", () => {
  const several = catalogue({
    connections: [
      {
        id: "c2",
        owner: "personal",
        provider: "anthropic",
        login: null,
        source: "anthropic",
        isDefault: false,
        ready: true,
        problem: null,
        default: "a1",
        models: [{ id: "a1", label: "Claude" }],
        listed: true,
      },
      {
        id: "c1",
        owner: "organization",
        provider: "openai",
        login: null,
        source: "openai",
        isDefault: true,
        ready: true,
        problem: null,
        default: "m1",
        models: [{ id: "m1", label: "Model One" }],
        listed: true,
      },
      {
        id: "c3",
        owner: "personal",
        provider: "newcomer",
        login: null,
        source: "newcomer",
        isDefault: false,
        ready: false,
        problem: null,
        default: "n1",
        models: [{ id: "n1", label: "New" }],
        listed: true,
      },
    ],
  } as Partial<ModelCatalogue>);
  const groups = modelGroups(several);
  expect(groups.map((group) => group.title)).toEqual(["OpenAI", "Anthropic"]);
  expect(groups[1]?.choices[0]?.saved).toEqual({
    model: "a1",
    effort: null,
    source: "anthropic",
  });
  expect(
    chosenModel({ model: "a1", effort: null, source: "anthropic" }, several)
      ?.key,
  ).toBe("c2:a1");
});
