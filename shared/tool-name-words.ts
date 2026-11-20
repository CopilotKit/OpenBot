/**
 * An app's tool named the way a person would say it, from the words a stored name splits into
 * (`humanise` in `./tool-name`): one rule set for every place a tool is named, so an app's page,
 * Activity, a conversation's step and an approval all say "Get IMAP settings" for
 * `GMAIL_SETTINGS_GET_IMAP`.
 *
 * Names written in capitals stay in capitals ("Update IMAP settings", "Who am I"), a verb the stored
 * name puts last comes first ("Calendar list get" reads "Get calendar list", "Settings get imap"
 * reads "Get IMAP settings"), and how the tool finds a thing by its ID goes ("Fetch message by
 * message id" reads "Fetch message", and "Fetch message by thread id" reads "Fetch thread
 * messages").
 */
export function nameInWords(label: string): string {
  let words = label
    .toLowerCase()
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
  if (
    words[0] === "stop" &&
    words.length === 2 &&
    TOOL_VERBS.has(words[1] ?? "")
  )
    words = ["stop", ing(words[1] as string)];
  const said = words.map((word) => NAMES[word] ?? word).join(" ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * A name with its first letter lower case, to sit inside a sentence ("wants to get IMAP settings"),
 * unless that letter starts a name written in capitals ("API root").
 */
export function lowerFirst(name: string): string {
  return /^[A-Z][a-z]/.test(name)
    ? name.charAt(0).toLowerCase() + name.slice(1)
    : name;
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
    TOOL_VERBS.has(words.at(-1) ?? "") &&
    !TOOL_VERBS.has(first) &&
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
export const TOOL_VERBS: ReadonlySet<string> = new Set([
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
