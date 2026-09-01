import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { UserAvatar } from "@/components/people/user-avatar";
import { useTheme } from "@/components/theme-provider";
import { AvatarUploadActions } from "@/components/ui/avatar-upload-actions";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { updateCurrentUserAvatarMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();
  const queryClient = useQueryClient();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const updateAvatar = useMutation(
    updateCurrentUserAvatarMutationOptions(queryClient),
  );

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      description="How OpenBot looks and behaves for you. These apply to your account alone, on every deployment you sign in to."
      title="Preferences"
    >
      <PageSection title="Profile">
        <PageRows>
          <Item size="sm">
            <div className="mr-3">
              <UserAvatar
                email={currentUser?.email}
                image={currentUser?.image}
                name={currentUser?.name}
                size={40}
              />
            </div>
            <ItemContent>
              <ItemTitle>Avatar</ItemTitle>
              <ItemDescription>PNG, JPEG, or WebP, up to 2 MB.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <AvatarUploadActions
                disabled={!currentUser}
                hasCustomImage={currentUser?.hasCustomAvatar === true}
                hasImage={Boolean(currentUser?.image)}
                label="your avatar"
                onChange={(image) => updateAvatar.mutateAsync(image)}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
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
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <PageSection title="Keyboard shortcuts">
        <PageRows>
          {HOTKEYS.map((hotkey, index) => (
            <React.Fragment key={hotkey.id}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{hotkey.label}</ItemTitle>
                  <ItemDescription>{hotkey.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="flex gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </ItemActions>
              </Item>
              {index !== HOTKEYS.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
