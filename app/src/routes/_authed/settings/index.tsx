import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { CompanySignInSection } from "@/components/settings/company-sign-in";
import { DeleteAccountSection } from "@/components/settings/delete-account";
import { MessageListPreference } from "@/components/settings/message-list-preference";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { StarOnGitHubSection } from "@/components/settings/star-on-github";
import { ThemeRow } from "@/components/settings/theme-row";
import { UsageDataSection } from "@/components/settings/usage-data";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { SkinPicker } from "@/skins/skin-picker";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that. So is the
   * AI Bots run on (AI providers): several providers, each with a page of its own.
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
      {/* Only where the organization has identity providers: the person's company account, and the way to link it. */}
      <CompanySignInSection />
      {/* Only in OpenBot Desktop, which sends usage data and keeps this choice. */}
      <UsageDataSection />
      <PageSection title="Appearance">
        <PageRows>
          <ThemeRow />
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
      {/* OpenBot itself rather than this person's OpenBot. Gone when the deployment says so. */}
      <StarOnGitHubSection />
      {/* Last, as GitHub and every settings page put it: deleting the account. */}
      <DeleteAccountSection />
    </PageShell>
  );
}
