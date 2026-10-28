import catalogJson from "@openbot/shared/standard-ui-catalog.json";
import {
  STANDARD_UI_CATALOG_ID,
  STANDARD_UI_FAMILIES,
  STANDARD_UI_GROUPS,
  standardUiComponentName,
  standardUiFamily,
} from "@openbot/shared/standard-ui";
import type { CatalogueEntry, GrantedComponent } from "./store";

/**
 * The standard catalog, governed like the gallery.
 *
 * The browser draws every standard component, so a conversation from before a change still renders,
 * and it sends the whole catalog with each run because the SDK gives it no way not to. What the
 * model is told is decided here instead: each run's catalog is rebuilt from the server's own copy,
 * keeping only the families this Bot holds, each in the words its administrator published. The
 * runtime then rejects any component the rebuilt catalog does not list, whatever the browser sent.
 */

type ComponentManifest = { description?: string } & Record<string, unknown>;

const CATALOG = catalogJson as unknown as {
  catalogId: string;
  components: Record<string, ComponentManifest>;
};

/** One gallery row per family, in the group's default publication. */
export const STANDARD_UI_CATALOGUE: CatalogueEntry[] = STANDARD_UI_FAMILIES.map(
  (family) => ({
    name: standardUiComponentName(family),
    title: family.title,
    kind: family.group,
    description: CATALOG.components[family.head]?.description ?? family.title,
    published: STANDARD_UI_GROUPS[family.group].publishedByDefault,
  }),
);

/**
 * The components a Bot holding these gallery rows is told about, or `undefined` when it holds no
 * standard family at all. The head of each family carries the published description.
 */
export function standardUiComponentsFor(
  granted: readonly GrantedComponent[],
): Record<string, ComponentManifest> | undefined {
  const components: Record<string, ComponentManifest> = {};
  for (const grant of granted) {
    const family = standardUiFamily(grant.name);
    if (!family) continue;
    for (const member of family.members) {
      const manifest = CATALOG.components[member];
      if (!manifest) continue;
      components[member] =
        member === family.head
          ? { ...manifest, description: grant.description }
          : manifest;
    }
  }
  return Object.keys(components).length > 0 ? components : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `/agent/<id>/run`, `/agent/<id>/connect` and `/agent/<id>/suggest`, under any base path. */
const AGENT_ROUTE = /\/agent\/([^/]+)\/(?:run|connect|suggest)$/;

/** The agent a request runs and the run input carrying the catalog, in either request shape. */
function locate(
  path: string,
  body: unknown,
): { agentId: string | undefined; input: unknown } | undefined {
  const route = AGENT_ROUTE.exec(path);
  if (route?.[1]) return { agentId: decodeURIComponent(route[1]), input: body };
  // The runtime's single-route shape: `{ method: "agent/run", params: { agentId }, body }`.
  if (
    isRecord(body) &&
    typeof body.method === "string" &&
    body.method.startsWith("agent/")
  ) {
    const agentId = isRecord(body.params) ? body.params.agentId : undefined;
    return {
      agentId: typeof agentId === "string" ? agentId : undefined,
      input: body.body,
    };
  }
  return undefined;
}

/**
 * The runtime's `beforeRequestMiddleware`: replaces the catalog a browser sent with the one this
 * Bot is allowed. Fails closed. A Bot that holds no family, an agent the request does not name, or a
 * grant that cannot be read all mean the run carries no catalog, and so no `render_ui` tool.
 */
export function governStandardUi(options: {
  listForAgent: (agentId: string) => Promise<GrantedComponent[]>;
}) {
  return async ({
    request,
    path,
  }: {
    request: Request;
    path: string;
  }): Promise<Request | undefined> => {
    if (request.method !== "POST") return undefined;
    if (!(request.headers.get("content-type") ?? "").includes("json"))
      return undefined;
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return undefined;
    }
    const located = locate(path, body);
    if (!located || !isRecord(located.input)) return undefined;
    const forwarded = located.input.forwardedProps;
    if (!isRecord(forwarded) || !isRecord(forwarded.copilotkit))
      return undefined;
    const namespace = forwarded.copilotkit;
    if (!("ui" in namespace)) return undefined;

    const components = located.agentId
      ? await options
          .listForAgent(located.agentId)
          .then(standardUiComponentsFor)
          .catch(() => undefined)
      : undefined;

    const sent = isRecord(namespace.ui) ? namespace.ui : {};
    const version = isRecord(sent["v1.0"]) ? sent["v1.0"] : {};
    const inline = Array.isArray(version.inlineCatalogs)
      ? version.inlineCatalogs
      : [];
    const ours = inline.find(
      (entry) => isRecord(entry) && entry.catalogId === STANDARD_UI_CATALOG_ID,
    ) as Record<string, unknown> | undefined;

    if (components && isRecord(sent.metadata)) {
      namespace.ui = {
        ...sent,
        "v1.0": {
          supportedCatalogIds: [STANDARD_UI_CATALOG_ID],
          inlineCatalogs: [
            {
              catalogId: STANDARD_UI_CATALOG_ID,
              protocolVersion: "1.0",
              components,
              // The renderer's built-in functions. Nothing governs them, and the model cannot call
              // them: in this SDK only the renderer does. Required, even when empty.
              functions: isRecord(ours?.functions) ? ours.functions : {},
            },
          ],
        },
      };
    } else {
      delete namespace.ui;
    }

    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request, { body: JSON.stringify(body), headers });
  };
}
