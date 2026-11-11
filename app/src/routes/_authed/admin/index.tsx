import { IconChevronRight } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ADMIN_SECTIONS } from "@/components/admin/admin-sections";
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

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Admin's overview: every Admin page, grouped by the thing a Bot has that it sets for everybody, in
 * the order the sidebar lists them (`ADMIN_SECTIONS`).
 */
function RouteComponent() {
  return (
    <PageShell
      description="Manage settings that apply to everyone and every Bot in this deployment."
      title="Admin"
    >
      {ADMIN_SECTIONS.map((section) => (
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
