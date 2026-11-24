import {
  A2uiCatalogError,
  A2uiGenerator,
  CatalogConfig,
  ExpressFormatFactory,
  type A2uiRequestProcessor,
  type RendererState,
} from "@a2ui/agent";
import {
  Catalog,
  basicCatalog,
  type AgentToRendererMessage,
  type CatalogApi,
} from "@a2ui/web_core/v1_0";

export const surfaceId = "spike";

export function spikeCatalog(pruned = false) {
  if (!pruned) return basicCatalog;
  return basicCatalog.derive({
    catalogId: "https://example.invalid/decision-spike/basic-pruned.json",
    components: [...basicCatalog.components.keys()].filter(
      (name) => !["Card", "List"].includes(name),
    ),
  });
}

export function createProcessor(catalog: CatalogApi) {
  // Match the renderer's ID, using schema-only entries on the agent side.
  const schemas = Catalog.fromJson(catalog.toJson(), "1.0", catalog.id);
  return new A2uiGenerator(
    [new CatalogConfig(schemas)],
    undefined,
    new ExpressFormatFactory({
      surfaceId,
    }),
  ).createProcessor({ "1.0": { supportedCatalogIds: [catalog.id] } });
}

// Proposed processor-level ingress. This is the same state transaction used
// by Parser.parseResponse for a complete block, with no textual round trip.
export function acceptMessages(
  processor: A2uiRequestProcessor,
  state: RendererState,
  messages: AgentToRendererMessage[],
): AgentToRendererMessage[] {
  if (!processor.acceptsState(state))
    throw new A2uiCatalogError("State uses different catalogs");
  return state.transaction(() => {
    state.checkTopology(state.apply(messages));
    return messages;
  });
}
