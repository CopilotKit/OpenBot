/**
 * The arguments of a streaming tool call with a half-arrived value held back.
 *
 * Partial JSON only ever stops at its end, so of everything drawn while a call streams only the last
 * value can be incomplete. A half-typed label reads fine and is kept, so text still appears as it is
 * written. A half-typed number is a different number (12 on its way to 125: the bar jumps), and a
 * half-typed link or colour is a broken one, so those are left out until something follows them or
 * the call completes. Everything else is shared with the input, not copied.
 */
export function settledArgs(
  args: Record<string, unknown>,
  complete: boolean,
): Record<string, unknown> {
  if (complete) return args;
  const path = lastLeaf(args);
  if (path === null) return args;
  const key = path.at(-1);
  const leaf = valueAt(args, path);
  if (key === undefined || !isUnsettled(String(key), leaf)) return args;
  return without(args, path) as Record<string, unknown>;
}

type Path = (string | number)[];

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** The path to the last scalar, walking the last key or element at every level. */
function lastLeaf(value: unknown): Path | null {
  if (!isContainer(value)) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item] as const)
    : Object.entries(value);
  const last = entries.at(-1);
  if (last === undefined) return null;
  const rest = lastLeaf(last[1]);
  return rest === null ? null : [last[0], ...rest];
}

function valueAt(value: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      isContainer(current)
        ? (current as Record<string | number, unknown>)[key]
        : undefined,
    value,
  );
}

const UNSETTLED_KEY = /(url|href|src|colou?r)$/i;

function isUnsettled(key: string, leaf: unknown): boolean {
  if (typeof leaf === "number") return true;
  if (typeof leaf !== "string") return false;
  return (
    UNSETTLED_KEY.test(key) || leaf.startsWith("#") || leaf.startsWith("http")
  );
}

function without(value: unknown, path: Path): unknown {
  const [key, ...rest] = path;
  if (key === undefined || !isContainer(value)) return value;
  if (Array.isArray(value)) {
    const copy = [...value];
    if (rest.length === 0) copy.splice(Number(key), 1);
    else copy[Number(key)] = without(copy[Number(key)], rest);
    return copy;
  }
  const record = value as Record<string, unknown>;
  if (rest.length === 0) {
    const { [String(key)]: _dropped, ...kept } = record;
    return kept;
  }
  return { ...record, [key]: without(record[String(key)], rest) };
}
