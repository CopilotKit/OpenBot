/**
 * Deterministic inspection of arguments before an MCP call leaves this deployment.
 *
 * This deliberately detects credentials, not general PII. A broad expression such as an email or
 * phone-number matcher would block ordinary connector work and turn a security boundary into a
 * source of false assurances. The findings contain only a category and a structural path: the
 * matched value must never be copied into an error, log, or audit row.
 */

export type SensitiveArgumentCategory =
  | "credential_field"
  | "private_key"
  | "provider_token"
  | "authorization_header";

export type SensitiveArgumentFinding = {
  category: SensitiveArgumentCategory;
  path: string;
};

export type ToolArgumentInspection =
  | { safe: true }
  | {
      safe: false;
      reason: "sensitive_content" | "inspection_limit" | "inspection_failed";
      findings: SensitiveArgumentFinding[];
    };

const sensitiveFieldNames = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "clientsecret",
  "credential",
  "credentials",
  "id_token",
  "idtoken",
  "password",
  "private_key",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "token",
]);

const providerTokenPatterns: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

const MAX_NODES = 2_000;
const MAX_DEPTH = 20;
const MAX_FINDINGS = 20;
const MAX_STRING_LENGTH = 64 * 1024;

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[-.\s]/g, "_");
}

function categoryForValue(value: string): SensitiveArgumentCategory | null {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value)) {
    return "private_key";
  }
  if (/^\s*(?:Basic|Bearer)\s+\S+/i.test(value)) {
    return "authorization_header";
  }
  if (providerTokenPatterns.some((pattern) => pattern.test(value))) {
    return "provider_token";
  }
  return null;
}

/**
 * A path is audit metadata, so it cannot repeat arbitrary argument keys. Keep ordinary schema-like
 * names useful and replace everything else with a structural marker. In particular, a credential
 * smuggled in a property name is detected but never copied into the finding that records it.
 */
function pathForKey(parent: string, key: string): string {
  const segment = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)
    ? key
    : "[property]";
  return `${parent}.${segment}`;
}

/**
 * Inspect JSON-shaped tool arguments without serialising them.
 *
 * JSON received by the route cannot be cyclic, but the store is also callable in-process. A
 * WeakSet makes that path fail closed rather than recurse forever. Size and depth limits bound the
 * work an authenticated but compromised Bot can ask this gateway to perform.
 */
export function inspectToolArguments(
  args: Record<string, unknown>,
): ToolArgumentInspection {
  try {
    const findings: SensitiveArgumentFinding[] = [];
    const seen = new WeakSet<object>();
    let nodes = 0;

    const visit = (value: unknown, path: string, depth: number): boolean => {
      nodes += 1;
      if (nodes > MAX_NODES || depth > MAX_DEPTH) return false;

      if (typeof value === "string") {
        if (value.length > MAX_STRING_LENGTH) return false;
        const category = categoryForValue(value);
        if (category && findings.length < MAX_FINDINGS) {
          findings.push({ category, path });
        }
        return true;
      }
      if (value === null || typeof value !== "object") return true;
      if (seen.has(value)) return false;
      seen.add(value);

      if (Array.isArray(value)) {
        return value.every((item, index) =>
          visit(item, `${path}[${index}]`, depth + 1),
        );
      }

      for (const [key, child] of Object.entries(value)) {
        if (key.length > MAX_STRING_LENGTH) return false;
        const keyCategory = categoryForValue(key);
        const childPath = pathForKey(path, keyCategory ? "[credential]" : key);
        if (keyCategory && findings.length < MAX_FINDINGS) {
          findings.push({ category: keyCategory, path: childPath });
        }
        if (
          sensitiveFieldNames.has(normalizedFieldName(key)) &&
          child !== null &&
          child !== ""
        ) {
          if (findings.length < MAX_FINDINGS) {
            findings.push({ category: "credential_field", path: childPath });
          }
          continue;
        }
        if (!visit(child, childPath, depth + 1)) return false;
      }
      return true;
    };

    if (!visit(args, "$", 0)) {
      return { safe: false, reason: "inspection_limit", findings: [] };
    }
    return findings.length === 0
      ? { safe: true }
      : { safe: false, reason: "sensitive_content", findings };
  } catch {
    return { safe: false, reason: "inspection_failed", findings: [] };
  }
}
