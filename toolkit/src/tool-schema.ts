/**
 * An app's tool schema, cut down to what every model provider accepts.
 *
 * FOUND LIVE. A Bot on the LangGraph harness, signed in to a ChatGPT plan, failed every message that
 * brought Gmail up: the Codex backend refused the whole request with "Invalid JSON schema: regex
 * lookaround is not supported. Found at $.properties.email_address.pattern." No app wrote that
 * pattern. The app's schema said `{"type": "string", "format": "email"}`, `parametersFor` read it as
 * `z.email()`, and `z.toJSONSchema` wrote it back out with zod's own email regex, which opens with
 * two negative lookaheads, `^(?!\.)(?!.*\.\.)`. Swept over Composio's whole catalogue (80,113 tools)
 * on 2026-11-08, that round trip and the apps' own patterns (Exa's webset ids,
 * `^(?!\.{1,2}$)…`) put a lookaround in 1,653 places, and 2,007 tools broke a documented rule.
 *
 * WHAT THE PROVIDERS ACCEPT, as they document it on 2026-11-08:
 * - OpenAI, Structured Outputs "Supported schemas"
 *   (https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas): `allOf`,
 *   `not`, `dependentRequired`, `dependentSchemas`, `if`, `then` and `else` are not supported, nor
 *   `patternProperties` on fine-tuned models; the root is an object and not `anyOf`; `anyOf` is
 *   supported; at most 5000 object properties, 10 levels of nesting and 1000 enum values. Its regex
 *   dialect is not documented, and lookaround is refused, as above.
 * - Anthropic, Structured Outputs "JSON Schema limitations"
 *   (https://platform.claude.com/docs/en/build-with-claude/structured-outputs): a `pattern` may not
 *   use backreferences, lookahead or lookbehind, or `\b`/`\B`; no external `$ref`; its list of string
 *   formats differs from OpenAI's. Its SDKs move each unsupported constraint into the field's
 *   description, which is what this does with the ones worth a model's reading.
 *
 * EVERY RULE ONLY LOOSENS. Each one removes a constraint and none adds one, so an argument the app
 * would take is never refused here: the app checks its own arguments and says what was wrong, which
 * is where that error belongs (see `parametersFor`).
 * - `format` goes, said in the description. Kept, zod turns it into a regex the provider has to
 *   compile, and the providers' lists of formats differ.
 * - A `pattern` goes when it uses anything outside the plain regex both providers document
 *   (lookaround, a backreference, a word boundary, a named or flagged group, a Unicode property), or
 *   when JavaScript cannot compile it, said in the description.
 * - `not`, `if`/`then`/`else`, `dependentRequired`, `dependentSchemas`, `dependencies`,
 *   `unevaluatedProperties` and `unevaluatedItems` go. They only forbid combinations.
 * - `allOf` is folded into the schema that holds it: properties and `required` lists joined, which
 *   is what "all of" means for an object. `oneOf` becomes `anyOf`.
 * - An object that has properties of its own AND a list of alternatives takes the alternatives'
 *   properties as optional ones of its own. Left as it was, zod reads the pair as an intersection,
 *   which comes back out as `allOf`; at the root it is not an object at all, and the tool was
 *   offered with no arguments named. Alternatives beside some other constraint carry it themselves.
 * - `patternProperties` goes; an object that allowed nothing else allows other keys again.
 * - Definitions kept under draft-07's `definitions` move to `$defs`, the only place zod reads
 *   them, and a `$ref` to a definition the schema does not carry goes. Either one made the whole
 *   tool an open object.
 * - Past ten levels of objects, an object keeps no properties of its own, and past 5000 properties
 *   in all the deepest level goes next; past 1000 enum values in all, the longest lists go first.
 *
 * Values are never walked: `enum`, `const`, `default` and `examples` are data, and a property named
 * `format` or `pattern` is a property, not a keyword.
 */

type Schema = Record<string, unknown>;

/** Keywords that only forbid combinations, which the app is left to refuse. */
const CONDITIONS = [
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "unevaluatedItems",
];

/** Keys that describe a schema without constraining it. */
const DESCRIBING = new Set([
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "$schema",
  "$id",
  "$defs",
  "definitions",
]);

/** Keywords whose value is one schema. */
const ONE = ["items", "additionalProperties", "contains", "propertyNames"];
/** Keywords whose value is a list of schemas. */
const LIST = ["anyOf", "oneOf", "allOf", "prefixItems"];
/** Keywords whose value maps names to schemas. */
const MAP = ["properties", "$defs", "definitions", "patternProperties"];

/** OpenAI's limits on one schema, from the page above. */
const MAX_NESTING = 10;
const MAX_PROPERTIES = 5000;
const MAX_ENUM_VALUES = 1000;

/** What every schema node of one tool is read against. */
type Reading = { definitions: Set<string>; nesting: number };

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a `pattern` stays: it compiles, and it uses only the plain regex both providers document
 * (anchors, character classes, `.`, `\d`, `\w`, `\s`, groups, `(?:…)` and quantifiers).
 */
export function isPortablePattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      // Backreferences (`\1`, `\k<name>`) and Unicode properties (`\p{L}`), in or out of a class.
      if (/[1-9kpP]/.test(next)) return false;
      // A word boundary; inside a class `\b` is a backspace, which is plain.
      if (!inClass && (next === "b" || next === "B")) return false;
      index++;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    // Any group that opens with `(?` but is not a plain `(?:…)`: lookaround, named, flagged, atomic.
    else if (char === "(" && pattern[index + 1] === "?") {
      if (pattern[index + 2] !== ":") return false;
    }
  }
  return true;
}

/** Joins one schema into another, as "all of" the two. The holder's own keys win. */
function fold(into: Schema, entry: Schema): void {
  for (const [key, value] of Object.entries(entry)) {
    if (key === "properties" && isSchema(value)) {
      into.properties = {
        ...value,
        ...(isSchema(into.properties) ? into.properties : {}),
      };
    } else if (key === "required" && Array.isArray(value)) {
      const held = Array.isArray(into.required) ? into.required : [];
      into.required = [...new Set([...held, ...value])];
    } else if (!(key in into)) {
      into[key] = value;
    }
  }
}

function isObjectSchema(schema: unknown): schema is Schema {
  return (
    isSchema(schema) &&
    (schema.type === "object" || isSchema(schema.properties))
  );
}

/** The definitions a `$ref` in this schema may point at, as the pointers that reach them. */
function definitionsOf(root: Schema): Set<string> {
  const found = new Set<string>(["#"]);
  if (isSchema(root.$defs))
    for (const name of Object.keys(root.$defs)) found.add(`#/$defs/${name}`);
  return found;
}

/**
 * Draft-07's `definitions`, under 2020-12's `$defs`. zod reads only `$defs`, and a schema that kept
 * its definitions under the older name had every reference into them refused.
 */
function underDefs(root: Schema): Schema {
  if (!isSchema(root.definitions)) return root;
  const { definitions, ...rest } = root;
  return {
    ...rest,
    $defs: { ...definitions, ...(isSchema(root.$defs) ? root.$defs : {}) },
  };
}

function portable(
  node: unknown,
  depth: number,
  reading: Reading,
  root = false,
): unknown {
  if (!isSchema(node)) return node;
  const out: Schema = { ...node };
  const notes: string[] = [];

  for (const key of CONDITIONS) delete out[key];
  if (typeof out.$ref === "string" && out.$ref.startsWith("#/definitions/"))
    out.$ref = `#/$defs/${out.$ref.slice("#/definitions/".length)}`;
  if (typeof out.$ref === "string" && !reading.definitions.has(out.$ref))
    delete out.$ref;

  if (typeof out.format === "string") notes.push(`Format: ${out.format}.`);
  delete out.format;
  if (typeof out.pattern === "string" && !isPortablePattern(out.pattern)) {
    notes.push(`Must match the regular expression ${out.pattern}`);
    delete out.pattern;
  }

  // Past the deepest nesting a provider takes, an object is taken as it comes.
  if (depth >= reading.nesting && isSchema(out.properties)) {
    delete out.properties;
    delete out.required;
    delete out.patternProperties;
    out.additionalProperties = true;
  }

  const inner = (schema: unknown, nested: number) =>
    portable(schema, nested, reading);
  for (const key of ONE)
    if (isSchema(out[key])) out[key] = inner(out[key], depth);
  for (const key of LIST) {
    const list = out[key];
    if (Array.isArray(list))
      out[key] = list.map((entry) => inner(entry, depth));
  }
  for (const key of MAP) {
    const map = out[key];
    if (!isSchema(map)) continue;
    const nested =
      key === "properties" || key === "patternProperties" ? depth + 1 : depth;
    out[key] = Object.fromEntries(
      Object.entries(map).map(([name, schema]) => [
        name,
        inner(schema, nested),
      ]),
    );
  }

  if (Array.isArray(out.oneOf)) {
    // Beside an `anyOf`, a `oneOf` only narrows it further, so the `anyOf` alone stands.
    if (!Array.isArray(out.anyOf)) out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  delete out.discriminator;

  if (Array.isArray(out.allOf)) {
    const entries = out.allOf;
    delete out.allOf;
    for (const entry of entries) {
      if (!isSchema(entry)) continue;
      // A second list of alternatives cannot share the first's keyword; the first stands.
      const { anyOf: _second, ...rest } = entry;
      fold(out, Array.isArray(out.anyOf) ? rest : entry);
    }
  }

  if (isSchema(out.patternProperties)) {
    const shapes = Object.values(out.patternProperties);
    delete out.patternProperties;
    if (out.additionalProperties === false)
      out.additionalProperties = shapes.length === 1 ? shapes[0] : true;
  }

  if (Array.isArray(out.anyOf)) {
    const choices = out.anyOf;
    const constrained = Object.keys(out).some(
      (key) => key !== "anyOf" && !DESCRIBING.has(key),
    );
    if (root || (isObjectSchema(out) && choices.every(isObjectSchema))) {
      // The alternatives' properties become optional ones of this object.
      delete out.anyOf;
      for (const choice of choices) {
        if (!isSchema(choice)) continue;
        if (isSchema(choice.properties))
          out.properties = {
            ...choice.properties,
            ...(isSchema(out.properties) ? out.properties : {}),
          };
      }
      out.type = "object";
    } else if (constrained) {
      // Each alternative carries what was said beside them, so nothing is left to intersect.
      const shared: Schema = {};
      for (const [key, value] of Object.entries(out))
        if (key !== "anyOf" && !DESCRIBING.has(key)) {
          shared[key] = value;
          delete out[key];
        }
      out.anyOf = choices.map((choice) => {
        if (!isSchema(choice)) return choice;
        const joined: Schema = { ...choice };
        fold(joined, shared);
        return joined;
      });
    }
  }

  if (root) delete out.default;

  if (notes.length > 0) {
    out.description = [
      typeof out.description === "string" ? out.description.trim() : "",
      ...notes,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return out;
}

/** Every `enum` list in a schema, so the longest can go first when there are too many values. */
function enumsOf(node: unknown, found: Schema[] = []): Schema[] {
  if (!isSchema(node)) return found;
  if (Array.isArray(node.enum)) found.push(node);
  for (const key of ONE) enumsOf(node[key], found);
  for (const key of LIST) {
    const list = node[key];
    if (Array.isArray(list)) for (const entry of list) enumsOf(entry, found);
  }
  for (const key of MAP) {
    const map = node[key];
    if (isSchema(map))
      for (const entry of Object.values(map)) enumsOf(entry, found);
  }
  return found;
}

/** How many object properties a schema names, at every level. */
function propertiesIn(node: unknown): number {
  if (!isSchema(node)) return 0;
  let count = isSchema(node.properties)
    ? Object.keys(node.properties).length
    : 0;
  for (const key of ONE) count += propertiesIn(node[key]);
  for (const key of LIST) {
    const list = node[key];
    if (Array.isArray(list))
      for (const entry of list) count += propertiesIn(entry);
  }
  for (const key of MAP) {
    const map = node[key];
    if (isSchema(map))
      for (const entry of Object.values(map)) count += propertiesIn(entry);
  }
  return count;
}

/** An app's tool schema with every construct a model provider refuses taken out. */
export function providerSafeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const root = underDefs(schema);
  const definitions = definitionsOf(root);
  let safe = portable(
    root,
    0,
    { definitions, nesting: MAX_NESTING },
    true,
  ) as Schema;
  // Too many properties in all: the deepest objects go first, a level at a time.
  for (let nesting = MAX_NESTING - 1; nesting > 0; nesting--) {
    if (propertiesIn(safe) <= MAX_PROPERTIES) break;
    safe = portable(root, 0, { definitions, nesting }, true) as Schema;
  }
  const enums = enumsOf(safe).sort(
    (a, b) => (b.enum as unknown[]).length - (a.enum as unknown[]).length,
  );
  let values = enums.reduce(
    (sum, node) => sum + (node.enum as unknown[]).length,
    0,
  );
  for (const node of enums) {
    if (values <= MAX_ENUM_VALUES) break;
    values -= (node.enum as unknown[]).length;
    delete node.enum;
  }
  return safe;
}
