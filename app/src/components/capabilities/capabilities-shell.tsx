import { useQuery } from "@tanstack/react-query";
import {
  Link,
  type LinkOptions,
  linkOptions,
  useMatchRoute,
} from "@tanstack/react-router";
import type * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * What a person gives their own Bots beyond the apps they connect: the skills they write and what
 * their Bots remember about them. Connections, the apps a Bot reaches as them, is its own page.
 *
 * Skills used to sit beside Bots and Memory in Settings, though both answer the same question: what
 * do my Bots know how to do, and what do they know about me?
 */
const TABS = [
  { label: "Skills", linkOptions: { to: "/capabilities/skills" } },
  { label: "Memory", linkOptions: { to: "/capabilities/memory" } },
] as const satisfies readonly { label: string; linkOptions: LinkOptions }[];

/**
 * The tabs are links drawn as buttons. Each page keeps its own address, so it can be bookmarked,
 * opened in a new tab and reached by Back. The match is fuzzy so a tab stays lit on a page beneath
 * it.
 */
export function CapabilitiesTabs() {
  const matchRoute = useMatchRoute();
  return (
    <nav aria-label="Capabilities" className="mt-6 flex items-center gap-1">
      {TABS.map((tab) => (
        <Button
          key={tab.label}
          render={(props) => <Link {...tab.linkOptions} {...props} />}
          variant={
            matchRoute({ ...tab.linkOptions, fuzzy: true })
              ? "secondary"
              : "ghost"
          }
        >
          {tab.label}
        </Button>
      ))}
    </nav>
  );
}

/**
 * The frame each tab draws itself in: the Capabilities title with the tabs beneath it, and no
 * description, since every section beneath them has its own title and says what it is for.
 *
 * A component each page renders rather than the `/capabilities` layout route drawing it once,
 * because Skills wraps its whole page — heading included — in the side panel that writes and edits a
 * skill. A heading drawn by the layout would sit outside that panel and stay full width while it is
 * open.
 */
export function CapabilitiesShell({ children }: { children: React.ReactNode }) {
  const matchRoute = useMatchRoute();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  /*
   * The personal edition has no Capabilities page: Skills and Memory open from the Bots page, so
   * each is titled for itself and goes back there, with no tabs to a page that isn't in the menu.
   */
  if (personal) {
    const tab =
      TABS.find((item) => matchRoute({ ...item.linkOptions, fuzzy: true })) ??
      TABS[0];
    return (
      <PageShell
        backButton={{ label: "Bots", linkProps: linkOptions({ to: "/bots" }) }}
        className="@container"
        title={tab.label}
      >
        {children}
      </PageShell>
    );
  }
  return (
    <PageShell className="@container" title="Capabilities">
      <CapabilitiesTabs />
      {children}
    </PageShell>
  );
}
