import { createFileRoute } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { DesktopNotificationsSetting } from "@/components/settings/desktop-notifications";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   */
  return (
    <PageShell
      description="How OpenBot looks and behaves for you. These apply to your account alone, on every deployment you sign in to."
      title="Preferences"
    >
      <PageSection title="General">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Dark theme</ItemTitle>
              <ItemDescription>
                Use the dark appearance across OpenBot.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Dark theme"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      {/*
       * Its own section rather than a third row under General, because unlike the theme this one is
       * about this browser and not about the account, and the description has to be able to say so.
       */}
      <PageSection title="Notifications">
        <PageRows>
          <DesktopNotificationsSetting />
          <p className="px-1 text-xs text-muted-foreground">
            This applies to this browser only, because the permission is granted
            per browser. Silencing an individual Bot is on that Bot's profile.
          </p>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
