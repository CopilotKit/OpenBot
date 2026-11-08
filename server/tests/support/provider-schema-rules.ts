/**
 * The JSON Schema rules a model provider applies to a tool's parameters, as a checker that names
 * every place a schema breaks one.
 *
 * Written from the providers' own documents, as they read on 2026-11-08, and from the refusal seen
 * live. A rule here is one of theirs, not one of ours:
 * - OpenAI, Structured Outputs "Supported schemas"
 *   (https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas): the root
 *   is an object and not `anyOf`; `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if`,
 *   `then` and `else` are unsupported, and `patternProperties` on fine-tuned models; `format` is one
 *   of date-time, time, date, duration, email, hostname, ipv4, ipv6, uuid; at most 5000 object
 *   properties, 10 levels of nesting and 1000 enum values.
 * - The Codex backend, live: "Invalid JSON schema: regex lookaround is not supported. Found at
 *   $.properties.email_address.pattern."
 * - Anthropic, Structured Outputs "JSON Schema limitations"
 *   (https://platform.claude.com/docs/en/build-with-claude/structured-outputs): no backreferences,
 *   no lookahead or lookbehind, no `\b`/`\B` in a `pattern`; no external `$ref`.
 * - OpenAI's function calling refuses an array schema with no `items` ("array schema missing items").
 */

const OPENAI_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

const UNSUPPORTED = [
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "patternProperties",
];

const ONE = ["items", "additionalProperties", "contains", "propertyNames"];
const LIST = ["anyOf", "oneOf", "prefixItems"];
const MAP = ["properties", "$defs", "definitions"];

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every construct in a `pattern` the providers refuse, by name. */
function regexFaults(pattern: string): string[] {
  const faults: string[] = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") faults.push("backreference");
      if (!inClass && (next === "b" || next === "B"))
        faults.push("word boundary");
      index++;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(" && pattern.startsWith("(?", index)) {
      if (/^\(\?<?[=!]/.test(pattern.slice(index))) faults.push("lookaround");
    }
  }
  return faults;
}

/** Every rule a tool's parameters break, each as `<path>: <rule>`. Empty when it would be accepted. */
export function providerSchemaFaults(root: unknown): string[] {
  const faults: string[] = [];
  let properties = 0;
  let enums = 0;
  if (!isSchema(root) || root.type !== "object")
    faults.push("$: the root is not an object");
  if (isSchema(root) && "anyOf" in root) faults.push("$: the root is anyOf");

  const walk = (node: unknown, path: string, depth: number) => {
    if (!isSchema(node)) return;
    // Object nesting, counted in `properties` maps entered.
    if (depth > 10) faults.push(`${path}: nested deeper than 10 levels`);
    for (const key of UNSUPPORTED)
      if (key in node) faults.push(`${path}: ${key} is not supported`);
    if (typeof node.format === "string" && !OPENAI_FORMATS.has(node.format))
      faults.push(`${path}.format: "${node.format}" is not a supported format`);
    if (typeof node.pattern === "string")
      for (const fault of regexFaults(node.pattern))
        faults.push(`${path}.pattern: regex ${fault} is not supported`);
    if (node.type === "array" && !("items" in node) && !("prefixItems" in node))
      faults.push(`${path}: array schema missing items`);
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#"))
      faults.push(`${path}.$ref: an external $ref is not supported`);
    if (Array.isArray(node.enum)) enums += node.enum.length;

    for (const key of ONE) walk(node[key], `${path}.${key}`, depth);
    for (const key of LIST) {
      const list = node[key];
      if (Array.isArray(list))
        list.forEach((entry, index) => {
          walk(entry, `${path}.${key}[${index}]`, depth);
        });
    }
    for (const key of MAP) {
      const map = node[key];
      if (!isSchema(map)) continue;
      if (key === "properties") properties += Object.keys(map).length;
      for (const [name, schema] of Object.entries(map))
        walk(
          schema,
          `${path}.${key}.${name}`,
          key === "properties" ? depth + 1 : depth,
        );
    }
  };
  walk(root, "$", 0);
  if (properties > 5000)
    faults.push(`$: ${properties} object properties, more than 5000`);
  if (enums > 1000) faults.push(`$: ${enums} enum values, more than 1000`);
  return faults;
}
