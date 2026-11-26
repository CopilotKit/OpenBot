/**
 * A Bot's settings as the phone decides them: who may change what, what each row says, and the
 * request each change sends. The same rules as the web app's Bot pages (app/src/components/bot-profile),
 * which read the server's verdicts on a Bot (`canManage`, `mine`, `assignedToMe`, `systemOwned`) and never
 * work them out again. It imports nothing that needs a phone, so it can be tested.
 */
import type {
  Bot,
  BotHandoff,
  BotResetCounts,
  ModelCatalogue,
  TeamBot,
  TeamBotPublication,
  UpdateBotRequest,
} from "./api/generated/model";

/* Who may change what. */

/**
 * Whether a role runs its organization. An owner governs it as an admin does. A role this app doesn't
 * know reads as the least it could be: a member.
 */
export function isAdmin(role: string | null | undefined): boolean {
  return role === "admin" || role === "owner";
}

/** Whether the person may change a Bot's Setup: the server's word on it, `canManage`. */
export function maySetUp(bot: Pick<Bot, "canManage">): boolean {
  return bot.canManage;
}

/**
 * Whether a Bot's page offers Sharing: never in the personal edition, which has nobody to share with;
 * otherwise to its owner, whoever may manage it and admins, who change it there, and to anyone it is
 * published to, who finds its link there.
 */
export function mayOpenSharing(
  bot: Pick<Bot, "mine" | "canManage">,
  {
    personal,
    admin,
    published = false,
  }: { personal: boolean; admin: boolean; published?: boolean },
): boolean {
  return !personal && (bot.mine || bot.canManage || admin || published);
}

/** Whether the person may change who can use a Bot. One that comes with OpenBot belongs to nobody. */
export function mayChangeVisibility(
  bot: Pick<Bot, "canManage" | "systemOwned">,
): boolean {
  return bot.canManage && !bot.systemOwned;
}

/** What the Manage rows offer for one Bot. */
export type ManageOffer = {
  /** An admin assigned it to the person: it stays pinned, and can't be hidden. */
  assigned: boolean;
  /** Whether Delete is offered: only to whoever may manage it, and never for one that comes with OpenBot. */
  canDelete: boolean;
};

export function manageOffer(
  bot: Pick<Bot, "assignedToMe" | "canManage" | "systemOwned">,
): ManageOffer {
  return {
    assigned: bot.assignedToMe === true,
    canDelete: bot.canManage && !bot.systemOwned,
  };
}

/* Setup: the text a Bot is made of, and the request that changes it. */

/** The text fields Setup edits, as typed. `instructions` only for the starter Bot, `endpoint` only for a Bot at an address. */
export type SetupDraft = {
  name: string;
  title: string;
  roleDescription: string;
  instructions?: string;
  endpoint?: string;
};

export type SetupErrors = Partial<Record<keyof SetupDraft, string>>;

/** Whether a Bot runs at an address of its own that the person sees: not one that runs inside OpenBot. */
export function hasOwnAddress(bot: Pick<Bot, "endpoint" | "builtIn">): boolean {
  return Boolean(bot.endpoint) && !bot.builtIn;
}

/** The form as the Bot stands. */
export function setupDraftOf(bot: Bot): SetupDraft {
  return {
    name: bot.name,
    title: bot.title,
    roleDescription: bot.roleDescription,
    ...(typeof bot.instructions === "string"
      ? { instructions: bot.instructions }
      : {}),
    ...(hasOwnAddress(bot) ? { endpoint: bot.endpoint ?? "" } : {}),
  };
}

/** The server's limits, said as the web app says them. */
export function checkSetup(draft: SetupDraft): SetupErrors {
  const errors: SetupErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Name is required.";
  else if (name.length > 80)
    errors.name = "Name must be 80 characters or fewer.";
  if (draft.title.trim().length > 120)
    errors.title = "Title must be 120 characters or fewer.";
  const role = draft.roleDescription.trim();
  if (!role)
    errors.roleDescription = "A description of what it does is required.";
  else if (role.length > 1000)
    errors.roleDescription = "What it does must be 1000 characters or fewer.";
  if (draft.instructions !== undefined) {
    const instructions = draft.instructions.trim();
    if (!instructions) errors.instructions = "Instructions are required.";
    else if (instructions.length > 1000)
      errors.instructions = "Instructions must be 1000 characters or fewer.";
  }
  if (
    draft.endpoint !== undefined &&
    !/^https?:\/\/\S+$/.test(draft.endpoint.trim())
  )
    errors.endpoint = "Enter a web address starting with http:// or https://.";
  return errors;
}

/** What may change besides the text: each is sent only when it changes. */
export type BotPatch = Partial<
  Pick<
    UpdateBotRequest,
    | "name"
    | "title"
    | "roleDescription"
    | "visibility"
    | "endpoint"
    | "isolated"
    | "instructions"
    | "defaultModel"
  >
>;

/**
 * The whole request for changing part of a Bot. The API takes the name, title, description and
 * visibility every time, so the ones not changing go as they are stored. The address, isolation,
 * instructions and default model go only when they change: absent, each is left as it is, and a key
 * is never sent, so the one set stays.
 */
export function botUpdate(bot: Bot, patch: BotPatch = {}): UpdateBotRequest {
  return {
    name: patch.name ?? bot.name,
    title: patch.title ?? bot.title,
    roleDescription: patch.roleDescription ?? bot.roleDescription,
    visibility: patch.visibility ?? bot.visibility,
    ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint } : {}),
    ...(patch.isolated !== undefined ? { isolated: patch.isolated } : {}),
    ...(patch.instructions !== undefined
      ? { instructions: patch.instructions }
      : {}),
    ...(patch.defaultModel !== undefined
      ? { defaultModel: patch.defaultModel }
      : {}),
  };
}

/**
 * What Save sends for the form: the errors to show, or the request, or nothing when nothing changed.
 * Text is trimmed as the server trims it. The same address saved back isn't sent to be checked again.
 */
export function setupRequest(
  bot: Bot,
  draft: SetupDraft,
): { errors: SetupErrors; request: UpdateBotRequest | null } {
  const errors = checkSetup(draft);
  if (Object.keys(errors).length > 0) return { errors, request: null };
  const patch: BotPatch = {};
  const name = draft.name.trim();
  const title = draft.title.trim();
  const roleDescription = draft.roleDescription.trim();
  if (name !== bot.name) patch.name = name;
  if (title !== bot.title) patch.title = title;
  if (roleDescription !== bot.roleDescription)
    patch.roleDescription = roleDescription;
  if (draft.instructions !== undefined) {
    const instructions = draft.instructions.trim();
    if (instructions !== bot.instructions) patch.instructions = instructions;
  }
  if (draft.endpoint !== undefined) {
    const endpoint = draft.endpoint.trim();
    if (endpoint !== bot.endpoint) patch.endpoint = endpoint;
  }
  if (Object.keys(patch).length === 0) return { errors, request: null };
  return { errors, request: botUpdate(bot, patch) };
}

/* Isolated: whether it has a computer of its own. */

/** What this OpenBot offers, from its `deployment` answer. */
export type Offers = { isolatedBots: boolean; hostedSignIn?: boolean };

const ISOLATED_EXPLAINED =
  "Runs in its own computer. Nothing it does can reach your other Bots' files or logins. Costs more to run.";
const ISOLATED_PUBLIC = "Everyone who uses this Bot shares that computer.";
const ISOLATION_WITHDRAWN =
  "Your admin turned off Isolated Bots, so this Bot runs on your computer.";

const isolationUnavailable = (cloud: boolean) =>
  cloud
    ? "OpenBot Cloud gives each person one computer, not one per Bot."
    : "This OpenBot can't give a Bot a computer of its own.";
const isolationGone = (cloud: boolean) =>
  cloud
    ? "OpenBot Cloud gives each person one computer, not one per Bot, so this Bot runs on your computer."
    : "This OpenBot can't give a Bot a computer of its own, so this Bot runs on your computer.";
const sharedComputer = (isPublic: boolean) =>
  isPublic
    ? "Runs on the computer of whoever is using it."
    : "Runs on your computer, alongside your other Bots.";

/**
 * The Isolated row: what it says, and whether its switch is shown and may be flipped. The switch shows
 * what the owner asked for; the sentence says what is happening, as the server decides it. Turning it
 * off is never refused. Turning it on is offered only where this OpenBot can make the computer: whether
 * the person holds Isolated Bots is the server's to refuse, since the phone doesn't read it.
 */
export function isolationRow(
  bot: Pick<
    Bot,
    | "canManage"
    | "systemOwned"
    | "isolated"
    | "isolationActive"
    | "isolationOffReason"
    | "visibility"
  >,
  offers: Offers | undefined,
): { summary: string; showSwitch: boolean; editable: boolean } {
  const available = offers?.isolatedBots ?? false;
  const cloud = offers?.hostedSignIn === true;
  const isPublic = bot.visibility === "public";
  const showSwitch = bot.canManage && !bot.systemOwned;
  const summary = bot.systemOwned
    ? "Comes with OpenBot, so it runs on the computer of whoever is using it."
    : bot.isolated
      ? bot.isolationActive
        ? isPublic
          ? `${ISOLATED_EXPLAINED} ${ISOLATED_PUBLIC}`
          : ISOLATED_EXPLAINED
        : bot.isolationOffReason === "admin"
          ? ISOLATION_WITHDRAWN
          : bot.isolationOffReason === "deployment"
            ? isolationGone(cloud)
            : sharedComputer(isPublic)
      : !available
        ? isolationUnavailable(cloud)
        : sharedComputer(isPublic);
  return {
    summary,
    showSwitch,
    editable: showSwitch && (bot.isolated || available),
  };
}

/* Who can use it. */

const capitalised = (words: string) =>
  words.charAt(0).toUpperCase() + words.slice(1);

/** "everyone in Acme", or "everyone in the organization" where the name isn't known. */
export function everyoneIn(organizationName?: string): string {
  return `everyone in ${organizationName?.trim() || "the organization"}`;
}

/** The two answers to who can use a Bot. */
export function visibilityChoices(organizationName?: string) {
  return [
    { value: "private" as const, label: "Only you" },
    {
      value: "public" as const,
      label: capitalised(everyoneIn(organizationName)),
    },
  ];
}

/** What the chosen answer means, with what it does to a Bot that has a computer of its own. */
export function visibilitySentence(
  bot: Pick<Bot, "visibility" | "isolationActive">,
  organizationName?: string,
): string {
  if (bot.visibility === "private")
    return bot.isolationActive
      ? "Only you can see it and start conversations with it. Making it public shares its computer, and anything signed in to there, with everyone who uses it."
      : "Only you can see it and start conversations with it.";
  const everyone = `${capitalised(everyoneIn(organizationName))} can find and use it.`;
  return bot.isolationActive
    ? `${everyone} Everyone who uses it shares its computer, so anything signed in to there is theirs too.`
    : everyone;
}

/**
 * The Sharing row's answer, as the web app's: who it is published to, or, while it isn't published,
 * who its visibility lets use it. A public Bot nobody published is still everyone's in the organization.
 */
export function sharingSummary(
  published: Pick<TeamBot, "audience"> | undefined,
  visibility: Bot["visibility"],
  organizationName?: string,
): string {
  if (!published)
    return visibility === "public"
      ? `${capitalised(everyoneIn(organizationName))} (public)`
      : "Not shared";
  return published.audience === "team"
    ? EVERYONE_WORDS
    : "Specific people and teams";
}

/* Publishing: who a Bot is published to, and who an admin assigned it to. */

/** Everybody in the organization, as an assignment names it. */
export const EVERYONE = "*";
const EVERYONE_WORDS = "Everyone in the organization";
const TEAM_VALUE = "team:";

/** A team as an assignment names it. */
export function teamValue(teamId: string): string {
  return `${TEAM_VALUE}${teamId}`;
}

/** The team an assignment names, or null for a directory group or everybody. */
export function teamOfValue(value: string): string | null {
  return value.startsWith(TEAM_VALUE) ? value.slice(TEAM_VALUE.length) : null;
}

type Named = { id: string; name: string };

const countLabel = (count: number, one: string, many: string) =>
  count === 0 ? "" : `${count} ${count === 1 ? one : many}`;

/** Whether the person may publish a Bot: it is theirs, and not published yet or published by them. */
export function mayPublish(bot: Pick<Bot, "mine">): boolean {
  return bot.mine;
}

/**
 * Who a published Bot reaches, by name: people by their address, teams by their name, and the directory
 * groups it was published to before there were teams. A team whose name isn't known is counted, never
 * shown by its id.
 */
export function publishedTo(
  published: Pick<TeamBot, "audience" | "people" | "teams" | "groups">,
  teams: readonly Named[] | undefined,
): string {
  if (published.audience === "team")
    return `To ${EVERYONE_WORDS.toLowerCase()}`;
  const named: string[] = [];
  let unnamed = 0;
  for (const teamId of published.teams ?? []) {
    const name = teams?.find((team) => team.id === teamId)?.name;
    if (name) named.push(name);
    else unnamed += 1;
  }
  const reached = [
    ...(published.people ?? []),
    ...named,
    ...(unnamed > 0 ? [countLabel(unnamed, "other team", "other teams")] : []),
    ...(published.groups ?? []).map((group) => `group ${group}`),
  ];
  return reached.length ? `To ${reached.join(", ")}` : "To nobody yet";
}

/** The Audience row's answer: who it is published to, as a count. */
export function audienceSummary(
  published:
    | Pick<TeamBot, "audience" | "people" | "teams" | "groups">
    | undefined,
  isPublic: boolean,
): string {
  if (!published)
    return isPublic ? "Choose who to publish it to" : "Not published";
  if (published.audience === "team") return EVERYONE_WORDS;
  const parts = [
    countLabel(published.people?.length ?? 0, "person", "people"),
    countLabel(published.teams?.length ?? 0, "team", "teams"),
    countLabel(published.groups?.length ?? 0, "group", "groups"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Specific people or teams";
}

/** The two audiences a Bot is published to. */
export const AUDIENCE_CHOICES = [
  { value: "team" as const, label: EVERYONE_WORDS },
  { value: "people" as const, label: "Specific people or teams" },
];

/**
 * What Publish sends. Everyone in the organization names nobody. Named people and teams keep the
 * directory groups it was published to before there were teams, sent back as they are.
 */
export function publication(input: {
  audience: "team" | "people";
  emails: readonly string[];
  teams: readonly string[];
  groups: readonly string[];
}): TeamBotPublication {
  const named = input.audience === "people";
  return {
    audience: input.audience,
    emails: named ? [...input.emails] : [],
    groups: named ? [...input.groups] : [],
    teams: named ? [...input.teams] : [],
  };
}

/** What an assignment is called: everyone, a team by its name, or a directory group by its own. */
export function assignmentName(
  value: string,
  teams: readonly Named[] | undefined,
): string {
  if (value === EVERYONE) return EVERYONE_WORDS;
  const teamId = teamOfValue(value);
  if (teamId === null) return `Group ${value}`;
  return (
    teams?.find((team) => team.id === teamId)?.name ?? "A team that was deleted"
  );
}

/** Who an admin can still assign a Bot to: everyone and each team, less what it has. */
export function assignChoices(
  assigned: readonly string[],
  teams: readonly Named[],
): { value: string; label: string }[] {
  const taken = new Set(assigned);
  return [
    { value: EVERYONE, label: EVERYONE_WORDS },
    ...teams.map((team) => ({ value: teamValue(team.id), label: team.name })),
  ].filter((choice) => !taken.has(choice.value));
}

/* Reaching you: where a Bot's conversations continue outside OpenBot. */

const TRANSPORT_NAMES: Record<string, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "SMS",
};

/** Where this Bot's conversations continue, each place once. One this app doesn't know shows by its id. */
export function reachSummary(transports: readonly string[]): string {
  const places = [...new Set(transports)]
    .map((transport) => TRANSPORT_NAMES[transport] ?? transport)
    .sort((a, b) => a.localeCompare(b));
  return places.length ? places.join(", ") : "Only in OpenBot";
}

/** A phone number as the API takes it: international form, such as +14155550123. */
export function isPhoneNumber(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

/** A verification code as the API takes it. */
export function isVerificationCode(code: string): boolean {
  return /^\d{4,10}$/.test(code.trim());
}

/* Notifications: how much one Bot may reach the person. */

export const NOTIFY_CHOICES = [
  { value: "all", label: "Everything" },
  { value: "needs_input", label: "Only when it needs me" },
  { value: "none", label: "Nothing (badges only)" },
] as const;

export type NotifyLevel = (typeof NOTIFY_CHOICES)[number]["value"];

/** A level as a person reads it. One a newer server sends that this app doesn't know reads as nothing. */
export function notifyLabel(level: string | undefined): string {
  return NOTIFY_CHOICES.find((choice) => choice.value === level)?.label ?? "";
}

/** Whether a picked menu entry is a level this app may send. Nothing it doesn't know is ever sent back. */
export function isNotifyLevel(value: string): value is NotifyLevel {
  return NOTIFY_CHOICES.some((choice) => choice.value === value);
}

/* Bots it can ask. */

type Placeable = { id: string; hidden: boolean };

/**
 * Which Bots the hand-off list draws a switch for, as the web app's `handoffRoster`. A Bot is never
 * offered itself. A Bot on the person's list is offered (only those already granted, when this Bot
 * can't be given new ones). A Bot they hid is listed only while it is granted, so that grant can still
 * be taken away. The count is over the rows drawn.
 */
export function handoffRoster<T extends Placeable>(input: {
  botId: string;
  roster: readonly T[];
  hidden: readonly T[];
  handoff: Pick<BotHandoff, "reachable" | "grantable">;
}): { candidates: T[]; granted: number; total: number } {
  const held = new Set(input.handoff.reachable);
  const isSelf = (candidate: T) => candidate.id === input.botId;
  const offered = input.roster.filter(
    (candidate) =>
      !isSelf(candidate) && (input.handoff.grantable || held.has(candidate.id)),
  );
  const shown = new Set(offered.map((candidate) => candidate.id));
  const strays = input.hidden.filter(
    (candidate) =>
      !isSelf(candidate) && held.has(candidate.id) && !shown.has(candidate.id),
  );
  const candidates = [...offered, ...strays];
  return {
    candidates,
    granted: candidates.filter((candidate) => held.has(candidate.id)).length,
    total: candidates.length,
  };
}

/** The grant that lets one Bot hand work to another, as the API addresses it. */
export function handoffGrantId(otherBotId: string): string {
  return `bot:${otherBotId}`;
}

/* Reset: what it would delete. */

/** Each count a reset deletes, in the words a person reads, skipping the kinds with nothing. */
export function resetLines(counts: BotResetCounts): string[] {
  const lines: [number, string, string][] = [
    [counts.conversations, "conversation", "conversations"],
    [counts.memorySources, "memory source", "memory sources"],
    [counts.memories, "imported memory", "imported memories"],
    [counts.routines, "routine", "routines"],
    [counts.responsibilities, "goal", "goals"],
    [counts.followUps, "scheduled follow-up", "scheduled follow-ups"],
    [counts.formedMemories, "memory it formed", "memories it formed"],
    [counts.backgroundResearch, "background research", "background research"],
    [counts.standingApprovals, "standing permission", "standing permissions"],
  ];
  return lines
    .filter(([count]) => typeof count === "number" && count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}

/* Default model. */

/** What a Bot's default model is saved as. */
export type SavedModel = {
  model: string;
  effort: string | null;
  source?: string;
};

/** One model a person can pick as a Bot's default. */
export type ModelChoice = { key: string; label: string; saved: SavedModel };

/** The models to pick from, by connection where there are several. */
export type ModelGroup = { title?: string; choices: ModelChoice[] };

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  xai: "xAI",
  unbiased: "Unbiased AI",
  trustedrouter: "TrustedRouter",
  "openai-compatible": "OpenAI-compatible",
};

/** A provider by its name. One this app doesn't know shows by its id. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/**
 * The connections to pick among, the default first, or none when there is one connection and it is
 * the default: the models on the catalogue itself are those.
 */
function connectionsOf(catalogue: ModelCatalogue | undefined) {
  const connections = catalogue?.connections ?? [];
  if (
    connections.length === 0 ||
    (connections.length === 1 && connections[0]?.isDefault)
  )
    return [];
  return [
    ...connections.filter((one) => one.isDefault),
    ...connections.filter((one) => !one.isDefault),
  ];
}

/**
 * The models a Bot's default can be, as the web app offers them: each at the model's own thinking
 * level. With several connections each group is one that can run now, and what is saved names the kind
 * of connection (`source`), never one person's connection.
 */
export function modelGroups(
  catalogue: ModelCatalogue | undefined,
): ModelGroup[] {
  if (!catalogue) return [];
  const connections = connectionsOf(catalogue);
  if (connections.length === 0)
    return [
      {
        choices: catalogue.models.map((option) => ({
          key: option.id,
          label: option.label,
          saved: { model: option.id, effort: null },
        })),
      },
    ];
  return connections
    .filter((connection) => connection.ready)
    .map((connection) => ({
      title: providerName(connection.provider),
      choices: connection.models.map((option) => ({
        key: `${connection.id}:${option.id}`,
        label: option.label,
        saved: { model: option.id, effort: null, source: connection.source },
      })),
    }));
}

/** The choice a Bot's saved default is, when the catalogue still offers it. */
export function chosenModel(
  saved: SavedModel | null | undefined,
  catalogue: ModelCatalogue | undefined,
): ModelChoice | undefined {
  if (!saved || !catalogue) return undefined;
  const several = connectionsOf(catalogue).length > 0;
  if (!several && saved.source !== catalogue.source) return undefined;
  for (const group of modelGroups(catalogue))
    for (const choice of group.choices)
      if (
        choice.saved.model === saved.model &&
        (!several || choice.saved.source === saved.source)
      )
        return choice;
  return undefined;
}

/** The Default model row's answer. */
export function defaultModelSummary(
  saved: SavedModel | null | undefined,
  catalogue: ModelCatalogue | undefined,
): string {
  const chosen = chosenModel(saved, catalogue);
  if (chosen) return chosen.label;
  if (saved && catalogue)
    return "The chosen model isn't available. New conversations use OpenBot's default.";
  if (saved) return saved.model;
  const deployment = catalogue?.models.find(
    ({ id }) => id === catalogue.default,
  );
  return deployment
    ? `OpenBot's default · ${deployment.label}`
    : "OpenBot's default";
}
