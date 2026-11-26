// The organization part of an API path is the same in every request of a scene, so the request
// rows show "…" in its place. The full path stays in the row's tooltip.

const ORG_PREFIX =
  /^\/api\/v2\/organizations\/(?:default|:organizationId)(?=\/|$|\?)/;

/** "/api/v2/organizations/default/bots?limit=100" → "…/bots?limit=100". Other paths stay as they are. */
export function shortPath(path: string): string {
  return path.replace(ORG_PREFIX, "…");
}

/** "GET /api/v2/organizations/:organizationId/bots" → "GET …/bots". */
export function shortRoute(route: string): string {
  const space = route.indexOf(" ");
  if (space === -1) return shortPath(route);
  return `${route.slice(0, space)} ${shortPath(route.slice(space + 1))}`;
}
