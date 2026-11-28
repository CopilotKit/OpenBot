import { IconChevronRight } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAdminSections } from "@/components/admin/admin-sections";
import { SharedComputersNotice } from "@/components/admin/shared-computers-notice";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { computerModeQueryOptions } from "@/lib/enterprise/queries";
import {
  asksForManagement,
  managementQueryOptions,
} from "@/lib/management/queries";
import { loadFirstScreenAfter } from "@/lib/route-data";

export const Route = createFileRoute("/_authed/admin/")({
  /*
   * Asks only for what the page would ask for: managed updates and the computer mode each carry the
   * condition their component sets, because `ensureQueryData` ignores `enabled` and would send reads
   * that the personal edition answers with a 404. A failed capabilities read counts as unknown, as
   * it does in the components.
   */
  loader: async ({ context }) => {
    // A router built without the app's context, as some tests build, has nothing to warm.
    if (!context.queryClient) return;
    const { queryClient } = context;
    await loadFirstScreenAfter(queryClient, {
      deciding: [
        currentUserQueryOptions(),
        deploymentCapabilitiesQueryOptions(),
      ],
      choose: () => {
        const user = queryClient.getQueryData(
          currentUserQueryOptions().queryKey,
        );
        const capabilities = queryClient.getQueryData(
          deploymentCapabilitiesQueryOptions().queryKey,
        );
        return [
          ...(asksForManagement({ isPending: false, data: capabilities })
            ? [managementQueryOptions()]
            : []),
          ...(isOrganizationAdmin(user?.role) &&
          capabilities?.edition === "team"
            ? [computerModeQueryOptions()]
            : []),
        ];
      },
    });
  },
  component: RouteComponent,
});

/**
 * Admin's overview: every Admin page, grouped by the thing a Bot has that it sets for everybody, in
 * the order the sidebar lists them (`useAdminSections()`). Above them, on an OpenBot whose Bots share one
 * computer, the notice that says so: the first page an admin opens is where they learn it.
 */
function RouteComponent() {
  const sections = useAdminSections();
  return (
    <PageShell
      description="Manage settings that apply to everyone and every Bot in this organization."
      title="Admin"
    >
      <SharedComputersNotice />
      {sections.map((section) => (
        <PageSection key={section.title} title={section.title}>
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <item.icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                    <ItemDescription>{item.description}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
