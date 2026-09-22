/**
 * A surface a tenant package brings with it.
 *
 * A package already declares coworkers, channels, skills and a look. What it could not declare is
 * work of its own: an area of the product that only makes sense for the deployment that wrote it —
 * a desk for one line of business — served by that deployment's own code. The only way to have one
 * was to name the deployment's bot id somewhere in the server, which is a fork of the server, not a
 * package.
 *
 * So the package declares the surface and the build keeps the module. The two meet on an id:
 * `surfaces.yaml` says a surface exists and which of this package's coworkers stands behind it, and
 * the build's own list says which ids it serves and where each one is mounted. Nothing in the code
 * has to name a tenant, and nothing in the package can name a path.
 *
 * The rules below are closed on purpose, because of who reads a surface: people. A declaration is
 * not a place for a credential — three keys are read and a fourth stops the deployment rather than
 * being ignored — and it is not a place to read the environment either, so `${NAME}` is refused
 * here even though every other package file expands it. A value read from the environment would be
 * published the moment the surface is drawn.
 */
export type TenantSurfaceDeclaration = {
  id: string;
  title: string;
  /** The coworker this surface belongs to, which the same package must also declare. */
  agentId: string;
};

/**
 * A surface this build can serve.
 *
 * `path` belongs to the build and never to the package, so a package cannot choose where a request
 * of its own lands.
 */
export type InstalledSurface = {
  id: string;
  path: string;
};

export type ResolvedSurface = TenantSurfaceDeclaration & {
  path: string;
};

/** More areas than this is not five surfaces and a typo; it is a file nobody read. */
export const MAX_DECLARED_SURFACES = 8;

const SURFACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TITLE = 80;
const DECLARED_KEYS = new Set(["id", "title", "agent_id"]);

function record(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new Error(`${source} must be a string`);
  }
  return value;
}

function identifier(value: unknown, source: string): string {
  const id = text(value, source);
  if (!SURFACE_ID.test(id)) {
    throw new Error(
      `${source} "${id}" must be lowercase letters, digits and hyphens, and start with a letter or digit`,
    );
  }
  return id;
}

function freeText(value: unknown, source: string): string {
  const shown = text(value, source).trim();
  if (!shown) throw new Error(`${source} must not be empty`);
  if (shown.length > MAX_TITLE) {
    throw new Error(`${source} may be at most ${MAX_TITLE} characters`);
  }
  if (shown.includes("${")) {
    throw new Error(
      `${source} may not contain \${...}: a surface is drawn for people, so a value read from the environment would be published by rendering it`,
    );
  }
  if (shown.includes("://")) {
    throw new Error(`${source} may not contain a URL`);
  }
  for (const character of shown) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`${source} may not contain control characters`);
    }
  }
  return shown;
}

/**
 * What `surfaces.yaml` declares, or empty for a package that brings none.
 *
 * Absent is a package with no surface of its own, which is every package written before this and
 * has to keep loading. Present and malformed is still refused, the way every other package file is.
 */
export function parseSurfaceDeclarations(
  value: unknown,
  source = "surfaces.yaml",
): TenantSurfaceDeclaration[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${source} surfaces must be a list`);
  }
  if (value.length > MAX_DECLARED_SURFACES) {
    throw new Error(
      `${source} declares ${value.length} surfaces, more than the ${MAX_DECLARED_SURFACES} this contract reads`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `${source} surface ${index + 1}`;
    const surface = record(entry, where);
    for (const key of Object.keys(surface)) {
      if (!DECLARED_KEYS.has(key)) {
        throw new Error(
          `${where} has key "${key}"; a surface reads id, title and agent_id and nothing else`,
        );
      }
    }
    const id = identifier(surface.id, `${where}.id`);
    if (seen.has(id)) {
      throw new Error(`${source} declares surface id "${id}" twice`);
    }
    seen.add(id);
    return {
      id,
      title: freeText(surface.title, `${where}.title`),
      agentId: identifier(surface.agent_id, `${where}.agent_id`),
    };
  });
}

/**
 * The declared surfaces this build can serve, or a refusal naming the one it cannot.
 *
 * Failing at load is the whole reason this exists. A package and a build travel together, so a
 * declaration with nothing behind it means one of them is older than the other, and the run that
 * notices first is the one to say so. The alternative is a deployment that starts, reports itself
 * healthy, and offers a door that answers nothing.
 */
export function resolveTenantSurfaces(
  declared: readonly TenantSurfaceDeclaration[],
  installed: readonly InstalledSurface[],
): ResolvedSurface[] {
  const byId = new Map(installed.map((surface) => [surface.id, surface]));
  return declared.map((surface) => {
    const module = byId.get(surface.id);
    if (!module) {
      const served = [...byId.keys()].join(", ") || "none";
      throw new Error(
        `surfaces.yaml declares surface "${surface.id}", which this build does not serve; this build serves ${served}`,
      );
    }
    return { ...surface, path: module.path };
  });
}
