import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { ProfileSettings } from "@/components/settings/profile";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";
import { SkinPicker } from "@/skins/skin-picker";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

const APPEARANCE: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function RouteComponent() {
  const { preference, setPreference } = useTheme();

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
      description="Customize OpenBot’s appearance and message display. Your skin and message settings apply to your account; the theme applies only to this browser."
      title="Preferences"
    >
      <ProfileSettings />
      <PageSection title="General">
        <PageRows>
          {/* Three choices, so a select like the message list's below, not a switch. */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Appearance</ItemTitle>
              <ItemDescription>
                System follows your device's light or dark setting.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select
                value={preference}
                onValueChange={(value) => {
                  if (value) setPreference(value);
                }}
              >
                <SelectTrigger aria-label="Appearance">
                  <SelectValue>{APPEARANCE[preference]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {THEME_PREFERENCES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {APPEARANCE[choice]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
          <Separator />
          <SkinPicker />
        </PageRows>
        <MessageListPreference />
      </PageSection>
      {/*
       * Above the shortcuts and below the appearance preferences, because it is the only thing on this
       * screen that changes what a coworker says rather than what this browser looks like.
       */}
      <StandingInstructions />
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
