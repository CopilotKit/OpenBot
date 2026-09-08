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
  | "authorization_header"
  | "payment_card"
  | "us_social_security_number"
  | "prompt_injection";

export type SensitiveArgumentFinding = {
  category: SensitiveArgumentCategory;
  path: string;
  action: "block" | "review";
};

export type ToolArgumentInspection =
  | { safe: true; findings: SensitiveArgumentFinding[] }
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
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

const MAX_NODES = 2_000;
const MAX_DEPTH = 20;
const MAX_FINDINGS = 20;
const MAX_STRING_LENGTH = 64 * 1024;

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[-.\s]/g, "_");
}

function credentialCategoryForValue(
  value: string,
): SensitiveArgumentCategory | null {
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

function hasValidPaymentCard(value: string): boolean {
  const candidates = value.match(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return sum % 10 === 0;
  });
}

function reviewCategoriesForValue(value: string): SensitiveArgumentCategory[] {
  const categories: SensitiveArgumentCategory[] = [];
  if (
    /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/.test(value)
  ) {
    categories.push("us_social_security_number");
  }
  if (hasValidPaymentCard(value)) categories.push("payment_card");
  if (
    /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions?\b/i.test(
      value,
    ) ||
    /\b(?:reveal|print|repeat|expose)\s+(?:the\s+)?(?:system|developer)\s+prompt\b/i.test(
      value,
    ) ||
    /<\|(?:system|developer)\|>/i.test(value)
  ) {
    categories.push("prompt_injection");
  }
  return categories;
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
    let mustBlock = false;

    const visit = (value: unknown, path: string, depth: number): boolean => {
      nodes += 1;
      if (nodes > MAX_NODES || depth > MAX_DEPTH) return false;

      if (typeof value === "string") {
        if (value.length > MAX_STRING_LENGTH) return false;
        const category = credentialCategoryForValue(value);
        if (category) mustBlock = true;
        if (category && findings.length < MAX_FINDINGS) {
          findings.push({ category, path, action: "block" });
        }
        for (const reviewCategory of reviewCategoriesForValue(value)) {
          if (findings.length < MAX_FINDINGS) {
            findings.push({
              category: reviewCategory,
              path,
              action: "review",
            });
          }
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
        const keyCategory = credentialCategoryForValue(key);
        if (keyCategory) mustBlock = true;
        const childPath = pathForKey(path, keyCategory ? "[credential]" : key);
        if (keyCategory && findings.length < MAX_FINDINGS) {
          findings.push({
            category: keyCategory,
            path: childPath,
            action: "block",
          });
        }
        for (const reviewCategory of reviewCategoriesForValue(key)) {
          if (findings.length < MAX_FINDINGS) {
            findings.push({
              category: reviewCategory,
              path: childPath,
              action: "review",
            });
          }
        }
        if (
          sensitiveFieldNames.has(normalizedFieldName(key)) &&
          child !== null &&
          child !== ""
        ) {
          mustBlock = true;
          if (findings.length < MAX_FINDINGS) {
            findings.push({
              category: "credential_field",
              path: childPath,
              action: "block",
            });
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
    return mustBlock
      ? { safe: false, reason: "sensitive_content", findings }
      : { safe: true, findings };
  } catch {
    return { safe: false, reason: "inspection_failed", findings: [] };
  }
}
