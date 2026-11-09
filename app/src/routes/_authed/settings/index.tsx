import { IconMoon } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { AiModelSection } from "@/components/settings/ai-connection";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { UsageDataSection } from "@/components/settings/usage-data";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { SkinPicker } from "@/skins/skin-picker";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

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
      description="Set your name, how OpenBot looks, and the instructions every Bot follows."
      title="General"
    >
      {/*
       * What OpenBot and every Bot know of the person, first: their name and how they want things done. Both are free
       * text, so both are a summary that opens a dialog.
       */}
      <PageSection title="About you">
        <PageRows>
          <NameRow />
          <Separator />
          <StandingInstructionsRow />
        </PageRows>
      </PageSection>
      {/* Only in OpenBot Desktop, which holds the AI connection and changes it in its own window. */}
      <AiModelSection />
      {/* Only in OpenBot Desktop, which sends usage data and keeps this choice. */}
      <UsageDataSection />
      <PageSection title="Appearance">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconMoon />
            </ItemMedia>
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
          <Separator />
          <SkinPicker />
        </PageRows>
        <MessageListPreference />
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
