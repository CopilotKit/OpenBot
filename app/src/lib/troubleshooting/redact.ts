/**
 * KEYS, TOKENS, PASSWORDS, COOKIES AND EMAIL ADDRESSES, REPLACED BEFORE A FILE IS SAVED.
 *
 * The same rules, in the same order, as OpenBot Desktop's log and troubleshooting file
 * (desktop/src-tauri/src/logging.rs, `RULES`, `redact` and `redact_keeping_ids`), so a file the web
 * app saves and one Desktop saves hide the same things. `shared/redaction-cases.json` holds real
 * lines and what each becomes; the app's tests and Desktop's both read it, so the two cannot drift.
 *
 * Errs towards replacing: a file that lost an identifier is still useful, and one that kept a key
 * cannot be sent to anybody.
 */

/** What replaces a secret. */
export const REDACTED = "[redacted]";

type Rule = {
  pattern: RegExp;
  /** What the match becomes, with `$<name>` for the parts kept (the name of a field, a scheme). */
  keep: string;
  /** For the shapes that are only secret some of the time: whether this match is one. */
  secret: (found: string) => boolean;
};

const always = () => true;

/**
 * A named credential's value, unless the value is the scheme of an `Authorization` header that the
 * rule before has already redacted: `Authorization: Bearer [redacted]` keeps saying Bearer.
 */
function namedValue(found: string): boolean {
  const lower = found.toLowerCase();
  return !["bearer", "basic"].some((scheme) => {
    if (!lower.endsWith(scheme)) return false;
    const before = lower.slice(0, lower.length - scheme.length);
    return [" ", ":", "=", '"', "'"].some((end) => before.endsWith(end));
  });
}

/**
 * A random string from a key generator, and not a word, a name or a number: long, and mixing
 * capitals, small letters and digits, which a container name or a path segment does not.
 */
function opaque(candidate: string): boolean {
  return (
    /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate)
  );
}

/** The name of anything that holds a credential: `OPENAI_API_KEY`, `refresh_token`, `x-api-key`. */
const CREDENTIAL_NAME =
  "[A-Za-z0-9_.\\-]*(?:api[_\\-]?key|apikey|[_\\-]key\\b|secret|token|password|passwd|pwd|cookie|authorization|credential|private[_\\-]?key|access[_\\-]?key|session[_\\-]?id)[A-Za-z0-9_.\\-]*";

function rule(pattern: string, flags: string, keep: string): Rule {
  return { pattern: new RegExp(pattern, `g${flags}`), keep, secret: always };
}

/** In order: a rule after another sees what the earlier one left. */
const RULES: Rule[] = [
  // A password in a URL: `https://user:password@host`.
  rule(
    "\\b(?<scheme>[a-z][a-z0-9+.\\-]*://)[^\\s/:@]+:[^\\s/@]+@",
    "i",
    "$<scheme>[redacted]@",
  ),
  // A cookie header, every pair of it.
  rule(
    "\\b(?<name>set-cookie|cookie)(?<sep>\\s*[:=]\\s*)[^\\r\\n]+",
    "i",
    "$<name>$<sep>[redacted]",
  ),
  // The secret Desktop's window carries to its relay, wherever it is written without "Cookie".
  rule("\\b(?<name>openbot-relay=)[^\\s;,\"']+", "i", "$<name>[redacted]"),
  // `Authorization: Bearer <token>`, `Basic <base64>`.
  rule("\\b(?<scheme>bearer)\\s+[^\\s\"',;]+", "i", "$<scheme> [redacted]"),
  rule(
    "\\b(?<scheme>Basic)\\s+[A-Za-z0-9+/]{12,}={0,2}",
    "",
    "$<scheme> [redacted]",
  ),
  // A credential's quoted value, spaces and all: `BETTER_AUTH_SECRET="correct horse battery staple"`.
  rule(
    `(?<name>${CREDENTIAL_NAME})(?<sep>\\s*=\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*')`,
    "i",
    "$<name>$<sep>[redacted]",
  ),
  // Anything named as a credential, with its value: `OPENAI_API_KEY=…`, `"refresh_token": "…"`.
  {
    pattern: new RegExp(
      `(?<name>${CREDENTIAL_NAME})(?<sep>["']?\\s*[:=]\\s*["']?)[^\\s"'&,;}\\]\\[][^\\s"'&,;}\\]]*`,
      "gi",
    ),
    keep: "$<name>$<sep>[redacted]",
    secret: namedValue,
  },
  // The parts of a sign-in URL that are a credential for as long as they live.
  rule(
    "(?<name>[?&](?:code|state|code_verifier|sig|signature|key|auth)=)[^&\\s#\"']+",
    "i",
    "$<name>[redacted]",
  ),
  // Keys and tokens by their providers' prefixes.
  rule(
    [
      "\\b(?:",
      "sk-[A-Za-z0-9_\\-]{8,}",
      "|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}",
      "|gh[pousr]_[A-Za-z0-9]{20,}",
      "|github_pat_[A-Za-z0-9_]{20,}",
      "|glpat-[A-Za-z0-9_\\-]{20,}",
      "|xox[abposr]-[A-Za-z0-9\\-]{10,}",
      "|xapp-[A-Za-z0-9\\-]{10,}",
      "|(?:AKIA|ASIA)[A-Z0-9]{16}",
      "|AIza[0-9A-Za-z_\\-]{35}",
      "|ya29\\.[0-9A-Za-z_\\-]+",
      "|npm_[A-Za-z0-9]{36}",
      "|hf_[A-Za-z0-9]{30,}",
      // OpenBot's own: an app's access token (`oba_`) and refresh token (`obr_`), and an API
      // key (`obk_`).
      "|ob[akr]_[A-Za-z0-9_\\-]{8,}",
      "|eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]*",
      ")",
    ].join(""),
    "",
    REDACTED,
  ),
  // An email address names a person.
  rule(
    "\\b[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)*\\.[A-Za-z]{2,}\\b",
    "",
    "[email]",
  ),
  // A long hexadecimal string: a generated secret as often as a digest.
  rule("\\b[0-9a-fA-F]{32,}\\b", "", REDACTED),
  // A long random string with no prefix at all.
  {
    pattern: /[A-Za-z0-9_\-+=]{20,}/g,
    keep: REDACTED,
    secret: opaque,
  },
];

/**
 * The last rules, which judge a string by its shape alone: a long hexadecimal string, and a long
 * random-looking one. An id the server made looks exactly like that.
 */
const SHAPE_RULES = 2;

function expand(keep: string, groups: Record<string, string | undefined>) {
  return keep.replace(/\$<(\w+)>/g, (_, name: string) => groups[name] ?? "");
}

function redactBy(text: string, rules: Rule[]): string {
  let out = text;
  for (const { pattern, keep, secret } of rules) {
    out = out.replace(pattern, (...args: unknown[]) => {
      const whole = args[0] as string;
      const last = args[args.length - 1];
      const groups =
        last && typeof last === "object"
          ? (last as Record<string, string | undefined>)
          : {};
      return secret(whole) ? expand(keep, groups) : whole;
    });
  }
  return out;
}

/** `text` with everything that looks like a key, a token, a password, a cookie or an email replaced. */
export function redact(text: string): string {
  return redactBy(text, RULES);
}

/**
 * `redact`, except for the rules that judge a string by its shape alone: for what is known to be an
 * id and never a credential, such as an API address's path once its query is gone, a request id, or
 * the account and organization ids. Those are long random strings, which the shape rules would
 * replace, and then a failure could not be found in the server's logs. Everything named as a
 * credential, a key or token by its provider's prefix, a JWT, a password in a URL and an email
 * address are still replaced.
 */
export function redactKeepingIds(text: string): string {
  return redactBy(text, RULES.slice(0, RULES.length - SHAPE_RULES));
}
