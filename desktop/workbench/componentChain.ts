// Finds the React components behind a DOM element, for the "Comment" mode of
// the workbench. It reads React's private fiber fields, so it is best effort
// and never throws.

/**
 * `file` is a repo path. `line` is a line of that source file. `at` is a position in the module
 * the dev server served, as a stack gives it: `resolveLines` (sourceLines.ts) turns it into a
 * `line` with the module's source map.
 */
export type ComponentInfo = {
  name: string;
  file?: string;
  line?: number;
  at?: ServedPosition;
};

export type ServedPosition = { url: string; line: number; column: number };

type Source = { file?: string; line?: number; at?: ServedPosition };

const INTERNAL_NAMES = new Set([
  "Suspense",
  "Fragment",
  "StrictMode",
  "Provider",
  "Consumer",
  "Context",
  "Profiler",
  "Offscreen",
  "Activity",
]);

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null
  );
}

function findFiber(element: Element): Loose | undefined {
  let node: Element | null = element;
  while (node) {
    for (const key of Object.getOwnPropertyNames(node)) {
      if (key.startsWith("__reactFiber$")) {
        const fiber = (node as unknown as Loose)[key];
        if (isObject(fiber)) return fiber;
      }
    }
    node = node.parentElement ?? null;
  }
  return undefined;
}

// A memo or forwardRef wrapper keeps the real function in type.type or type.render.
function componentType(type: unknown): Loose | undefined {
  if (!isObject(type)) return undefined;
  if (typeof type === "function") return type as unknown as Loose;
  const inner = type.type ?? type.render;
  if (typeof inner === "function") return inner as unknown as Loose;
  if (isObject(inner)) return componentType(inner);
  return undefined;
}

function nameOf(type: unknown): string | undefined {
  const outer = isObject(type) ? (type.displayName as unknown) : undefined;
  if (typeof outer === "string" && outer) return outer;
  const inner = componentType(type);
  if (!inner) return undefined;
  const name = inner.displayName ?? inner.name;
  return typeof name === "string" && name ? name : undefined;
}

function repoPath(fileName: string): string | undefined {
  let path = fileName;
  try {
    path = new URL(fileName).pathname;
  } catch {
    path = fileName.split("?")[0] ?? fileName;
  }
  path = decodeURIComponent(path);
  // The app frame's modules are served under /__app/: only its src/ is app source.
  const app = path.indexOf("/__app/src/");
  if (app !== -1) return `app/src/${path.slice(app + "/__app/src/".length)}`;
  if (path.includes("/__app/")) return undefined;
  const index = path.indexOf("/src/");
  if (index === -1 || path.includes("/node_modules/")) return undefined;
  return `desktop${path.slice(index)}`;
}

function parseFrame(stack: string): Source | undefined {
  for (const raw of stack.split("\n")) {
    const match = raw.match(
      /(https?:\/\/[^\s()]+|file:\/\/[^\s()]+|\/[^\s()]+)/,
    );
    if (!match) continue;
    // Vite adds "?t=123" before the line and column: "/src/A.tsx?t=123:45:12".
    const text = match[1] ?? "";
    const parts = text.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
    const url = parts?.[1] ?? text;
    const file = repoPath(url);
    if (!file) continue;
    // A stack gives the line in the served module, not in the source file: keep it as `at`.
    if (!parts?.[2]) return { file };
    return {
      file,
      at: {
        url,
        line: Number(parts[2]),
        column: parts[3] ? Number(parts[3]) : 1,
      },
    };
  }
  return undefined;
}

// Where this fiber was created: React 19 records the stack of the JSX call
// site, which is the render of the owner. Older React gives _debugSource.
function sourceOf(fiber: Loose): Source {
  try {
    const source = fiber._debugSource;
    if (isObject(source) && typeof source.fileName === "string") {
      const file = repoPath(source.fileName);
      if (file) {
        return {
          file,
          line:
            typeof source.lineNumber === "number"
              ? source.lineNumber
              : undefined,
        };
      }
    }
    const stack = isObject(fiber._debugStack)
      ? fiber._debugStack.stack
      : undefined;
    if (typeof stack === "string") return parseFrame(stack) ?? {};
  } catch {
    // Best effort only.
  }
  return {};
}

/**
 * Where a component draws the path to the element: the nearest fiber under it on the path that
 * its own render created (its `_debugOwner`). For the innermost component that is the JSX of the
 * element itself. Without owners, where the component itself was created.
 */
function locationOf(component: Loose, below: readonly Loose[]): Source {
  const owned = below.find((f) => f._debugOwner === component);
  const source = owned ? sourceOf(owned) : {};
  return source.file ? source : sourceOf(component);
}

export function componentChain(element: Element, max = 6): ComponentInfo[] {
  try {
    const chain: ComponentInfo[] = [];
    const below: Loose[] = [];
    let fiber = findFiber(element);
    let guard = 0;
    while (fiber && chain.length < max && guard++ < 5000) {
      const name = nameOf(fiber.type);
      if (name && !name.startsWith("_") && !INTERNAL_NAMES.has(name)) {
        if (chain[chain.length - 1]?.name !== name) {
          const { file, line, at } = locationOf(fiber, below);
          const info: ComponentInfo = { name };
          if (file) {
            info.file = file;
            if (line !== undefined) info.line = line;
            if (at) info.at = at;
          }
          chain.push(info);
        }
      }
      below.push(fiber);
      const next: unknown = fiber.return;
      fiber = isObject(next) ? next : undefined;
    }
    return chain;
  } catch {
    return [];
  }
}

export function formatChain(chain: ComponentInfo[]): string {
  const names = chain.map((c) => c.name).join(" › ");
  const located = chain.find((c) => c.file);
  if (!located?.file) return names;
  return `${names} · ${located.file}${located.line !== undefined ? `:${located.line}` : ""}`;
}
