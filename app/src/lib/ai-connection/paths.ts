import { linkOptions } from "@tanstack/react-router";
import { createContext, useContext } from "react";
import type { ConnectionScope } from "./queries";

/**
 * What a person reads as the name of these screens: the Settings and Admin entries, the page's
 * heading and every Back link to it. "Providers" alone didn't say what they provide, and people
 * looking for where to connect their AI didn't find it. The addresses keep `providers`.
 */
export const AI_PROVIDERS_TITLE = "AI providers";

/**
 * Where the AI providers screens live: Settings → AI providers for everyone who sets an AI, and
 * Admin → AI providers for an admin. Both draw the same pages
 * (`components/settings/provider-pages.tsx`), so every link between them goes through here rather
 * than naming `/settings` or `/admin`.
 *
 * A provider's page is named by its connection's id (its provider) and whose list it is in: on
 * OpenBot Cloud a person's own and the organization's may share an id, so a person's own carries
 * `?owner=personal`. The organization's carries nothing.
 */
export type ProvidersPlace = "settings" | "admin";

/**
 * `connected`: the page was reached by connecting it just now, and says what that did. `added`:
 * beside the others, not the default. `in-use`: a run with no pick uses it now.
 */
export type JustConnected = "added" | "in-use";

export type ProviderSearch = { owner?: "personal"; connected?: JustConnected };

/** The search every provider page reads: `owner=personal`, or nothing for the organization's. */
export function providerSearch(
  search: Record<string, unknown>,
): ProviderSearch {
  return {
    ...(search.owner === "personal" ? { owner: "personal" as const } : {}),
    ...(search.connected === "added" || search.connected === "in-use"
      ? { connected: search.connected }
      : {}),
  };
}

/** Whose list a page's search names. */
export function scopeOf(search: ProviderSearch): ConnectionScope {
  return search.owner === "personal" ? "personal" : "organization";
}

function searchOf(
  scope: ConnectionScope,
  connected?: JustConnected,
): ProviderSearch {
  return {
    ...(scope === "personal" ? { owner: "personal" as const } : {}),
    ...(connected ? { connected } : {}),
  };
}

export function providerPaths(place: ProvidersPlace) {
  if (place === "admin")
    return {
      place,
      list: () => linkOptions({ to: "/admin/providers" }),
      provider: (
        id: string,
        scope: ConnectionScope,
        connected?: JustConnected,
      ) =>
        linkOptions({
          to: "/admin/providers/$provider",
          params: { provider: id },
          search: searchOf(scope, connected),
        }),
      change: (id: string, scope: ConnectionScope) =>
        linkOptions({
          to: "/admin/providers/$provider/change",
          params: { provider: id },
          search: searchOf(scope),
        }),
      connect: (scope: ConnectionScope) =>
        linkOptions({ to: "/admin/providers/new", search: searchOf(scope) }),
    };
  return {
    place,
    list: () => linkOptions({ to: "/settings/providers" }),
    provider: (id: string, scope: ConnectionScope, connected?: JustConnected) =>
      linkOptions({
        to: "/settings/providers/$provider",
        params: { provider: id },
        search: searchOf(scope, connected),
      }),
    change: (id: string, scope: ConnectionScope) =>
      linkOptions({
        to: "/settings/providers/$provider/change",
        params: { provider: id },
        search: searchOf(scope),
      }),
    connect: (scope: ConnectionScope) =>
      linkOptions({ to: "/settings/providers/new", search: searchOf(scope) }),
  };
}

export type ProviderPaths = ReturnType<typeof providerPaths>;

/** Settings unless a page says otherwise: Admin → AI providers wraps its screens in the admin paths. */
export const ProviderPathsContext = createContext<ProviderPaths>(
  providerPaths("settings"),
);

export function useProviderPaths(): ProviderPaths {
  return useContext(ProviderPathsContext);
}

/**
 * A provider's page in Settings as a plain address, for a conversation that leaves for it with a
 * whole page load (stopped-connection-notice.tsx).
 */
export function providerAddress(id: string, owner?: string): string {
  const whose = owner === "personal" ? "?owner=personal" : "";
  return `/settings/providers/${encodeURIComponent(id)}${whose}`;
}

/** Where a provider's connection is changed in Settings, as a plain address (providerAddress). */
export function providerChangeAddress(id: string, owner?: string): string {
  const whose = owner === "personal" ? "?owner=personal" : "";
  return `/settings/providers/${encodeURIComponent(id)}/change${whose}`;
}

export const PROVIDERS_ADDRESS = "/settings/providers";
