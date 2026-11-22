// Finds the React components behind a DOM element, for the "Comment" mode of
// the workbench. It reads React's private fiber fields, so it is best effort
// and never throws.

export type ComponentInfo = { name: string; file?: string; line?: number };

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
  const index = path.indexOf("/src/");
  if (index === -1 || path.includes("/node_modules/")) return undefined;
  return `desktop${path.slice(index)}`;
}

function parseFrame(
  stack: string,
): { file: string; line?: number } | undefined {
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
    const line = parts?.[2] ? Number(parts[2]) : undefined;
    return { file, line };
  }
  return undefined;
}

// Where this element was created: React 19 records the stack of the JSX call
// site, which is the render of the owner. Older React gives _debugSource.
function sourceOf(fiber: Loose): { file?: string; line?: number } {
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

export function componentChain(element: Element, max = 6): ComponentInfo[] {
  try {
    const chain: ComponentInfo[] = [];
    let fiber = findFiber(element);
    let guard = 0;
    while (fiber && chain.length < max && guard++ < 5000) {
      const name = nameOf(fiber.type);
      if (name && !name.startsWith("_") && !INTERNAL_NAMES.has(name)) {
        if (chain[chain.length - 1]?.name !== name) {
          const { file, line } = sourceOf(fiber);
          const info: ComponentInfo = { name };
          if (file) {
            info.file = file;
            if (line !== undefined) info.line = line;
          }
          chain.push(info);
        }
      }
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
