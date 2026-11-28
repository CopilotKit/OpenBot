import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { nativeShell } from "@/lib/native-shell/shell";
import { useSettingsItems } from "./settings-sidebar";

/**
 * Settings' other pages, as rows on General, inside the phone app's native shell only: there is no
 * sidebar there to list them (`routes/_authed/settings/route.tsx`). The sidebar's entries, in its
 * order, General left out since this is it. Each page leads back here.
 */
export function SettingsPageRows() {
  if (!nativeShell()) return null;
  return <SettingsPageRowsList />;
}

function SettingsPageRowsList() {
  const { items, toFix } = useSettingsItems();
  const pages = items.filter((item) => item.linkOptions.to !== "/settings");
  if (pages.length === 0) return null;
  return (
    <PageSection title="More settings">
      <PageRows>
        {pages.map((page, index) => (
          <Fragment key={page.title}>
            <Item
              render={(props) => <Link {...page.linkOptions} {...props} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <page.icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{page.title}</ItemTitle>
              </ItemContent>
              <ItemActions>
                {page.setup && toFix > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {toFix} {toFix === 1 ? "needs" : "need"} setup
                  </span>
                ) : null}
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            {index !== pages.length - 1 ? <Separator /> : null}
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
