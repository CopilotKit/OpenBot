/**
 * Take the secrets out of a shell command before it is kept or exported.
 *
 * The approach is the one secret scanners use (gitleaks, detect-secrets, GitHub secret scanning):
 * known token shapes by prefix, then credentials by the name they are passed under, then anything in
 * a URL's userinfo. Each match is replaced with `[REDACTED]` in place, so the command stays readable
 * ("curl -H 'Authorization: Bearer [REDACTED]' https://api.example.com") and an investigator can see
 * what was run without the record becoming a credential store.
 *
 * Deliberately over-eager. A redacted word that was not a secret costs a reader a guess; a secret
 * that survived costs a rotation.
 */

const REDACTED = "[REDACTED]";

/** Token shapes with a vendor prefix or a fixed form. */
const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI, Anthropic
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(sk|rk)_(live|test)_[0-9a-zA-Z]{16,}\b/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
];

/** Names a credential is usually passed under, as an assignment, a flag or a header. */
const SECRET_NAME =
  "(?:[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)";

const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // Authorization headers: `Authorization: Bearer x`, `-H "Authorization: Basic x"`.
  [
    /(authorization\s*[:=]\s*(?:bearer|basic|token|digest)?\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_match, lead) => `${lead}${REDACTED}`,
  ],
  [
    /(x-api-key\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // A quoted key in a JSON body: `-d '{"password":"x"}'`, or `-d "{\\"password\\":\\"x\\"}"` once the
  // shell quoting around it has escaped the inner quotes. The rule below stops at the closing quote
  // of the key, so it never saw these.
  [
    new RegExp(
      `(\\\\?["']${SECRET_NAME}\\\\?["']\\s*:\\s*)(\\\\"[^"\\\\]*\\\\"|"[^"]*"|'[^']*'|[^\\s,}'"\\\\]+)`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `NAME=value`, `export NAME=value`, `--name=value`, `NAME: value`.
  [
    new RegExp(
      `((?:--?)?${SECRET_NAME}\\s*[=:]\\s*)(?!\\[REDACTED\\]|(?:bearer|basic|token|digest)\\s)("[^"]*"|'[^']*'|[^\\s'"]+)`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `--password value`, `--token value`.
  [
    new RegExp(
      `(--?${SECRET_NAME}\\s+)("[^"]*"|'[^']*'|[^\\s'"-][^\\s'"]*)`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `-psecret` for mysql and friends, `-p secret` too.
  [
    /(\bmysql(?:dump)?\b[^|;&]*?\s-p)(\S+)/gi,
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `curl -u user:password`, and the other ways curl takes it: `-uuser:password`,
  // `--user=user:password`, and either of them with the pair in quotes.
  [
    /(\s(?:-u\s*|--user(?:=|\s+)))(?:"([^":]*):[^"]*"|'([^':]*):[^']*'|([^\s:"']+):\S+)/g,
    (_m, lead, doubleQuoted, singleQuoted, bare) => {
      const user = doubleQuoted ?? singleQuoted ?? bare;
      return `${lead}${user}:${REDACTED}`;
    },
  ],
  // Userinfo in any URL: `https://user:pass@host`.
  [
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`,
  ],
];

export function scrubCommand(command: string): string {
  let scrubbed = command;
  for (const shape of TOKEN_SHAPES)
    scrubbed = scrubbed.replace(shape, REDACTED);
  for (const [pattern, replace] of RULES) {
    scrubbed = scrubbed.replace(
      pattern,
      replace as (substring: string, ...args: string[]) => string,
    );
  }
  return scrubbed;
}
