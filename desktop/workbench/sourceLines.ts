// Turns the served positions of a component chain into lines of the source files. A browser
// stack gives the line in the module the dev server served (types and imports changed), so
// the line is read from the module's source map.

import type { CommentTarget, PickedElement } from "./commentPrompt";
import type { ComponentInfo } from "./componentChain";

type Load = (url: string) => Promise<string>;
type SourceMap = { sources: string[]; mappings: string };
export type MapCache = Map<string, Promise<SourceMap | null>>;

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
}

function decodeBase64(text: string): string {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The values of one mappings segment. */
function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit === -1) return [];
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

/** The source and the 1-based line for a 1-based served line and column, or null. */
export function originalPosition(
  map: SourceMap,
  line: number,
  column: number,
): { source: string; line: number } | null {
  const lines = map.mappings.split(";");
  if (line < 1 || line > lines.length) return null;
  // The source, line and column fields carry on from segment to segment over the whole map.
  let source = 0;
  let origLine = 0;
  let best: { source: number; line: number } | null = null;
  for (let index = 0; index < line; index++) {
    let genColumn = 0;
    for (const segment of (lines[index] ?? "").split(",")) {
      if (!segment) continue;
      const [col = 0, src, ln] = decodeVlq(segment);
      genColumn += col;
      if (src === undefined || ln === undefined) continue;
      source += src;
      origLine += ln;
      // Original column (the fourth field) is not needed.
      if (index === line - 1 && genColumn <= column - 1) {
        best = { source, line: origLine };
      }
    }
  }
  if (!best) return null;
  const name = map.sources[best.source];
  return name === undefined ? null : { source: name, line: best.line + 1 };
}

function readMap(code: string, url: string, load: Load) {
  const refs = [...code.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)];
  const ref = refs[refs.length - 1]?.[1];
  if (!ref) return Promise.resolve(null);
  const inline = ref.match(
    /^data:application\/json;(?:charset=[^;,]+;)?base64,(.*)$/,
  );
  const text = inline?.[1]
    ? Promise.resolve(decodeBase64(inline[1]))
    : load(new URL(ref, url).href);
  return text.then((json) => JSON.parse(json) as SourceMap);
}

function mapOf(url: string, load: Load, cache: MapCache) {
  let found = cache.get(url);
  if (!found) {
    found = load(url)
      .then((code) => readMap(code, url, load))
      .catch(() => null);
    cache.set(url, found);
  }
  return found;
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** The chain with source lines where the source map gives them, and without served positions. */
export async function resolveLines(
  chain: readonly ComponentInfo[],
  load: Load = fetchText,
  cache: MapCache = new Map(),
): Promise<ComponentInfo[]> {
  return Promise.all(
    chain.map(async ({ at, ...info }) => {
      if (!at || !info.file || info.line !== undefined) return info;
      const map = await mapOf(at.url, load, cache);
      const found = map && originalPosition(map, at.line, at.column);
      // A map for some other file is not this file's map.
      if (!found || baseName(found.source) !== baseName(info.file)) return info;
      return { ...info, line: found.line };
    }),
  );
}

/** The target with source lines in every chain. */
export async function resolveTarget(
  target: CommentTarget,
  load: Load = fetchText,
): Promise<CommentTarget> {
  const cache: MapCache = new Map();
  const one = async (el: PickedElement): Promise<PickedElement> => ({
    ...el,
    chain: await resolveLines(el.chain, load, cache),
  });
  if (target.kind === "element") {
    return { ...target, element: await one(target.element) };
  }
  return { ...target, elements: await Promise.all(target.elements.map(one)) };
}
