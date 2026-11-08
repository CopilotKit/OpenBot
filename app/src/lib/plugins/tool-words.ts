import { appToolName } from "@openbot/shared/tool-name";

/**
 * One of an app's tools as a person reads it in a list of tools, on the app's page and on a Bot's
 * What it can do: what it does, in words ("Add label to email", not `GMAIL_ADD_LABEL_TO_EMAIL`), and
 * what its description says it does.
 *
 * FOR THE PERSONAL EDITION'S APP PAGE. Team Admin keeps the stored name, which is what an admin
 * writes a rule against and finds on the tool's own page.
 */
export function toolInWords(
  serverId: string,
  tool: { name: string; description: string },
): { label: string; summary: string | null } {
  return {
    label: toolName(serverId, tool.name),
    summary: toolSummary(tool.description),
  };
}

/**
 * A tool's name in a list of tools: the words a conversation gives it (`appToolName`), always as a
 * command ("Create goal", where Activity says what was done, "Created a goal"), with the habits of a
 * stored name taken out. Names written in capitals stay in capitals ("Update IMAP settings"), a verb
 * the stored name puts last comes first ("Calendar list get" reads "Get calendar list", "Settings get
 * IMAP" reads "Get IMAP settings"), and how the tool finds a thing by its ID goes, as it does from a
 * description ("Fetch message by message id" reads "Fetch message", and "Fetch message by thread id"
 * reads "Fetch thread messages").
 */
export function toolName(serverId: string, name: string): string {
  let words = appToolName(serverId, name)
    .label.toLowerCase()
    .replace(/\bgraph ql\b/g, "graphql")
    .replace(/\bab test/g, "a/b test")
    .replace(/\bsend as\b/g, "send-as")
    .split(/\s+/)
    .filter(Boolean);
  words = withoutFindingByName(words);
  // Settings come after what they are settings for: "Get IMAP settings", "Get send-as settings".
  const settings = words[0] === "settings" && words.length > 1;
  if (settings) words = words.slice(1);
  if (verbPutLast(words))
    words = [words.at(-1) as string, ...words.slice(0, -1)];
  if (settings) words = [...words, "settings"];
  // "Stop watch" stops watching.
  if (words[0] === "stop" && words.length === 2 && VERBS.has(words[1] ?? ""))
    words = ["stop", ing(words[1] as string)];
  const said = words.map((word) => NAMES[word] ?? word).join(" ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * Whether a stored name puts its verb last, as a vendor's path does ("Calendar list get", "Acl
 * delete"). Not a name that reads as words already: one that opens on a verb, or says "a", "for" or
 * "from" ("Rerequest a check run", where "run" is the thing).
 */
function verbPutLast(words: readonly string[]): boolean {
  const first = words[0] ?? "";
  return (
    words.length > 1 &&
    VERBS.has(words.at(-1) ?? "") &&
    !VERBS.has(first) &&
    !LEADS_A_VERB.has(first) &&
    !words.some((word) => GLUE.has(word))
  );
}
const GLUE: ReadonlySet<string> = new Set([
  "a",
  "an",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

/**
 * A stored name's "by id" taken out: "Get user by id" reads "Get user". Where it finds things by
 * something else's ID, that something says whose: "Fetch message by thread id" reads "Fetch thread
 * messages". Left where the ID is one of two ways ("by id or property").
 */
function withoutFindingByName(words: string[]): string[] {
  const by = words.lastIndexOf("by");
  const tail = words.slice(by + 1);
  if (by < 1 || !/^ids?$/.test(tail.at(-1) ?? "") || tail.length > 2)
    return words;
  const before = words.slice(0, by);
  const whose = tail.length === 2 ? (tail[0] as string) : null;
  const thing = before.at(-1) ?? "";
  if (!whose || whose === thing || before.length < 2) return before;
  return [
    ...before.slice(0, -1),
    whose,
    thing.endsWith("s") ? thing : `${thing}s`,
  ];
}

/** A verb's -ing form: "watch" as "watching", "update" as "updating". */
function ing(verb: string): string {
  return /[^e]e$/.test(verb) ? `${verb.slice(0, -1)}ing` : `${verb}ing`;
}

/**
 * Names a stored name writes in lower case, as they are written: ID, IMAP, POP, CSE, CRM, API. And
 * "I", which a stored name lower-cases with everything else ("Who am I").
 */
const NAMES: Readonly<Record<string, string>> = {
  "a/b": "A/B",
  acl: "ACL",
  ai: "AI",
  api: "API",
  apis: "APIs",
  ci: "CI",
  cms: "CMS",
  crm: "CRM",
  cse: "CSE",
  csv: "CSV",
  dm: "DM",
  dms: "DMs",
  dnd: "DND",
  dns: "DNS",
  gdpr: "GDPR",
  gpg: "GPG",
  graphql: "GraphQL",
  html: "HTML",
  i: "I",
  id: "ID",
  idp: "IdP",
  ids: "IDs",
  imap: "IMAP",
  ip: "IP",
  jit: "JIT",
  json: "JSON",
  lfs: "LFS",
  llm: "LLM",
  mime: "MIME",
  oauth: "OAuth",
  oidc: "OIDC",
  pdf: "PDF",
  pop: "POP",
  rtm: "RTM",
  saml: "SAML",
  sarif: "SARIF",
  sbom: "SBOM",
  scim: "SCIM",
  sha: "SHA",
  smime: "S/MIME",
  sms: "SMS",
  smtp: "SMTP",
  sql: "SQL",
  ssh: "SSH",
  ssl: "SSL",
  sso: "SSO",
  ui: "UI",
  url: "URL",
  urls: "URLs",
  utc: "UTC",
  uuid: "UUID",
  vcs: "VCS",
  xml: "XML",
};

/**
 * Verbs a tool's name or description opens with, in their plain form. What tells "Calendar list get"
 * (a verb put last) from "Get calendar list", and "Create a new filter" (a command) from "Creates a
 * new filter". From the names and descriptions of Composio's Gmail, GitHub, HubSpot, Slack, Google
 * Calendar, Google Drive and Notion.
 */
const VERBS: ReadonlySet<string> = new Set([
  "abort",
  "accept",
  "add",
  "append",
  "apply",
  "approve",
  "archive",
  "assign",
  "block",
  "browse",
  "cancel",
  "change",
  "check",
  "clear",
  "clone",
  "close",
  "commit",
  "compare",
  "complete",
  "configure",
  "connect",
  "convert",
  "copy",
  "create",
  "decline",
  "delete",
  "disable",
  "dismiss",
  "download",
  "duplicate",
  "edit",
  "empty",
  "enable",
  "encrypt",
  "end",
  "execute",
  "export",
  "fetch",
  "finalize",
  "find",
  "follow",
  "force",
  "fork",
  "forward",
  "generate",
  "get",
  "hide",
  "import",
  "insert",
  "invite",
  "join",
  "leave",
  "list",
  "lock",
  "look",
  "lookup",
  "manage",
  "mark",
  "merge",
  "modify",
  "move",
  "open",
  "parse",
  "patch",
  "pause",
  "perform",
  "pin",
  "ping",
  "post",
  "publish",
  "purge",
  "query",
  "read",
  "remove",
  "rename",
  "render",
  "reopen",
  "replace",
  "reply",
  "report",
  "request",
  "rerequest",
  "reserve",
  "reset",
  "restore",
  "restrict",
  "resume",
  "retrieve",
  "return",
  "review",
  "revoke",
  "run",
  "schedule",
  "search",
  "send",
  "set",
  "share",
  "star",
  "start",
  "stop",
  "submit",
  "subscribe",
  "sync",
  "test",
  "transfer",
  "trash",
  "unarchive",
  "unblock",
  "unfollow",
  "unhide",
  "unlock",
  "unpin",
  "unstar",
  "unsubscribe",
  "untrash",
  "update",
  "upload",
  "upsert",
  "validate",
  "verify",
  "watch",
  "write",
]);

/** First words that come before a verb and are not what it acts on: "Quick add", "Re run". */
const LEADS_A_VERB: ReadonlySet<string> = new Set(["quick", "re"]);

/**
 * The first sentence of a tool's description, or null when there is none a person can read.
 *
 * A description is written for the model. Its first sentence says what the tool does, and the rest
 * tells the model how to call it, by the ids of its parameters and of other tools (`message_id`,
 * `GMAIL_FETCH_EMAILS`, `listLabels`). The first clause before a semicolon is where the vendor's
 * summary ends and that advice starts, so it ends the sentence too. A sentence that still names an
 * id is not shown at all: a row with the tool's words and no sentence says less, but nothing wrong.
 */
export function toolSummary(description: string): string | null {
  const first = description
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z])|;\s/)[0]
    ?.trim();
  if (!first || NAMES_AN_ID.test(first)) return null;
  const plain = inPlainWords(first);
  if (!plain) return null;
  return /[.!?]$/.test(plain) ? plain : `${plain}.`;
}

/**
 * Text that names an id rather than says a thing: code in backticks, words joined by an underscore
 * (`user_id`, `GMAIL_SEND_DRAFT`), a word that starts lower case and carries a capital
 * (`listLabels`, `historyId`), or one of three or more capitalised parts (`CalendarListGet`), which
 * is longer than a brand name runs (GitHub, HubSpot).
 */
const NAMES_AN_ID =
  /`|\w_\w|\b[a-z]+[A-Z]\w*|\b[A-Z][a-z]+(?:[A-Z][a-z]+){2,}\b/;

/**
 * The vendor's sentence with the habits of text written for a model taken out, and nothing else
 * changed: the "Tool to" it opens with, how it finds a thing ("by its ID", which a person has no ID
 * to give), and words in capitals ("Permanently DELETES"). It says what the tool does, as most
 * vendors' sentences already do: "Tool to create a filter" and "Create a filter" read "Creates a
 * filter".
 */
function inPlainWords(sentence: string): string {
  const bare = sentence.replace(/^_(.*)_(\.?)$/, "$1$2");
  const command = COMMAND.test(bare);
  const plain = bare
    .replace(COMMAND, "")
    .replace(/^tool that\s+/i, "")
    .replace(BY_ITS_ID, withoutFindingById)
    .replace(/\b[A-Z]{2,}\b(:?)/g, (word: string, label: string) => {
      const bare = word.slice(0, word.length - label.length);
      if (!shouted(bare)) return word;
      // A label keeps its capital: "CRITICAL: content" reads "Critical: content".
      return label
        ? `${bare.charAt(0)}${bare.slice(1).toLowerCase()}${label}`
        : bare.toLowerCase();
    })
    .trim();
  const said = whatItDoes(plain, command);
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * What a vendor writes before the command that says what a tool does: "Tool to", "Use this tool to",
 * "Use to", "Action to", "Call this to", "Call this action to".
 */
const COMMAND =
  /^(?:(?:use this )?tool to|use to|action to|call this (?:action |tool )?to)\s+/i;

/**
 * A sentence that opens on a command, opened on what the tool does instead: "Permanently delete a
 * filter" as "Permanently deletes a filter". Past any adverbs before the verb. `command` says the
 * sentence is one whatever its first word, because "Tool to" came off it; otherwise only a verb this
 * file knows counts, and not one that names a thing ("List of").
 */
function whatItDoes(sentence: string, command: boolean): string {
  const words = sentence.split(" ");
  let at = 0;
  while (
    at < words.length - 1 &&
    ((/^[a-z]+ly$/i.test(words[at] ?? "") &&
      !VERBS.has(words[at]?.toLowerCase() ?? "")) ||
      (at > 0 && words[at]?.toLowerCase() === "and"))
  )
    at++;
  // A verb with something before it, "Batch-read" or "Sparse-update", is said by its last part.
  const word = words[at] ?? "";
  const hyphen = word.lastIndexOf("-") + 1;
  const verb = word.slice(hyphen);
  if (
    !/^[a-z]+$/i.test(verb) ||
    words[at + 1]?.toLowerCase() === "of" ||
    !(command || VERBS.has(verb.toLowerCase()))
  )
    return sentence;
  words[at] = word.slice(0, hyphen) + saysIt(verb);
  // And a second command it goes on to, on a thing of its own: "and return its state" as "and
  // returns its state". Not a word for a thing ("or archive status", "create and update events").
  for (let next = at + 1; next < words.length - 1; next++) {
    if (!/^(?:and|or)$/i.test(words[next] ?? "")) continue;
    if (VERBS.has((words[next - 1] ?? "").toLowerCase())) continue;
    let then = next + 1;
    while (/^[a-z]+ly$/i.test(words[then] ?? "") && then < words.length - 1)
      then++;
    if (
      VERBS.has(words[then] ?? "") &&
      /^(?:a|an|the|it|its|them|their)$/i.test(words[then + 1] ?? "")
    )
      words[then] = saysIt(words[then] ?? "");
  }
  return words.join(" ");
}

/** "create" as "creates", "fetch" as "fetches", "query" as "queries", "lookup" as "looks up". */
function saysIt(verb: string): string {
  const lower = verb.toLowerCase();
  const said =
    lower === "lookup"
      ? "looks up"
      : lower === "have"
        ? "has"
        : /[^aeiou]y$/.test(lower)
          ? `${lower.slice(0, -1)}ies`
          : /(?:s|sh|ch|x|z|o)$/.test(lower)
            ? `${lower}es`
            : `${lower}s`;
  return verb.charAt(0) === verb.charAt(0).toUpperCase()
    ? said.charAt(0).toUpperCase() + said.slice(1)
    : said;
}

/**
 * How a tool finds a thing by its ID: "by ID", "by its ID", "by thread ID", "using its ID", "by
 * message and attachment IDs", and "identified by its ID" or "specified by its ID", with the commas
 * around it. Never where it orders or filters rather than finds ("sorted by ID").
 */
const BY_ITS_ID =
  /(,?\s+(?:identified|specified))?\s+(?<!\b(?:sorted|ordered|filterable|filtered|filtering)\s+)(?:by|using)\s+(?:its\s+|their\s+|the\s+)?(?:[a-z]+\s+(?:and\s+[a-z]+\s+)?)?IDs?\b(,)?/g;

/**
 * One {@link BY_ITS_ID} taken out, or left where the ID is one of the things a tool finds by, which a
 * person can give the others of: "by its ID or name", "by its channel ID and timestamp", "by their IDs
 * (or a specified unique property)", "by ID, email, name, or other text". An "and" that goes on to
 * what the tool does is not one of them: "by ID and removes it from messages".
 */
function withoutFindingById(
  found: string,
  named: string | undefined,
  comma: string | undefined,
  at: number,
  sentence: string,
): string {
  const rest = sentence.slice(at + found.length);
  const oneOfSeveral = comma
    ? /^\s+(?!\w+ing\b)[^,.]+,/.test(rest)
    : /^\s*\(?or\b|^\s+and\s+(?!\w+(?:s|ing)\b)/.test(rest);
  if (oneOfSeveral) return found;
  // "policy, identified by its ID, from" reads "policy from".
  return named?.startsWith(",") ? "" : (comma ?? "");
}

/**
 * Whether a word in capitals is a word said loudly ("DELETES", "PENDING") or a name written that way
 * (ID, CRM, HTML, IMAP). Five letters or more is a word, but for the few longer names vendors use;
 * four or fewer is a name, but for the few short words they capitalise. Both lists are what Composio's
 * Gmail, GitHub, HubSpot, Slack, Google Calendar, Google Drive and Notion descriptions use.
 */
function shouted(word: string): boolean {
  return word.length >= 5 ? !LONG_NAMES.has(word) : SHORT_WORDS.has(word);
}
const LONG_NAMES = new Set([
  "ASCII",
  "CNAME",
  "GRAPHQL",
  "HTTPS",
  "LICENSE",
  "OAUTH",
  "README",
  "SARIF",
]);
const SHORT_WORDS = new Set([
  "ALL",
  "ANY",
  "CALL",
  "MUST",
  "NEW",
  "NOT",
  "NOTE",
  "ONLY",
  "TASK",
]);
