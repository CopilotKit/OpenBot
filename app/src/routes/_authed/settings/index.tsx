import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { ProfileSettings } from "@/components/settings/profile";
import { SegmentedChoice } from "@/components/settings/segmented-choice";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  BOT_FACES,
  type BotFaces,
  setBotFaces,
  useBotFaces,
  usePrefersReducedMotion,
} from "@/lib/bot-faces";
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

/** What each choice does, said under the row while it is chosen. */
const APPEARANCE_DESCRIPTION: Record<ThemePreference, string> = {
  system: "OpenBot follows your device's light or dark setting.",
  light: "OpenBot stays light, whatever your device is set to.",
  dark: "OpenBot stays dark, whatever your device is set to.",
};

const BOT_FACES_LABEL: Record<BotFaces, string> = {
  animated: "Animated",
  working: "Only while working",
  still: "Still",
};

const BOT_FACES_DESCRIPTION: Record<BotFaces, string> = {
  animated: "Bot faces blink, look around and follow your pointer.",
  working: "Bot faces move only while a Bot is listening or working.",
  still: "Bot faces never move.",
};

function RouteComponent() {
  const { preference, setPreference } = useTheme();
  const faces = useBotFaces();
  const reducedMotion = usePrefersReducedMotion();

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
      description="Customize OpenBot’s appearance and message display. Your skin and message settings apply to your account. The theme and Bot faces apply only to this browser."
      title="Preferences"
    >
      <ProfileSettings />
      <PageSection title="General">
        <PageRows>
          {/* A few short choices, all in view at once, so a segmented control. */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Appearance</ItemTitle>
              <ItemDescription>
                {APPEARANCE_DESCRIPTION[preference]}
              </ItemDescription>
            </ItemContent>
            <ItemFooter>
              <SegmentedChoice
                label="Appearance"
                labels={APPEARANCE}
                onChange={setPreference}
                options={THEME_PREFERENCES}
                value={preference}
              />
            </ItemFooter>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Bot faces</ItemTitle>
              <ItemDescription>
                {reducedMotion
                  ? "Your device asks for less motion, so Bot faces never move."
                  : BOT_FACES_DESCRIPTION[faces]}
              </ItemDescription>
            </ItemContent>
            <ItemFooter>
              <SegmentedChoice
                label="Bot faces"
                labels={BOT_FACES_LABEL}
                onChange={setBotFaces}
                options={BOT_FACES}
                value={faces}
              />
            </ItemFooter>
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
