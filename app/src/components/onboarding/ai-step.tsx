import { IconBuilding, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import {
  ChooseConnection,
  ChooserCard,
  ConnectedRow,
} from "@/components/settings/ai-connection-chooser";
import { Button } from "@/components/ui/button";
import {
  type PersonalAiConnection,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import { StepIntro } from "./onboarding-frame";
import type { OnboardingStep } from "./onboarding-wizard";

/**
 * Onboarding's Connect your AI step, on an OpenBot that provides no AI of its own (OpenBot Cloud):
 * the person connects their own before they use OpenBot, with a key or an address, or by signing in
 * to a provider the server can sign them in to. Theirs alone: it follows them into every
 * organization they are in and is never shared with any of them.
 *
 * ONLY WHERE IT IS NEEDED, AND NO WAY PAST IT. The route puts the step in the list only when the
 * server says one is required and this person's runs have none (`needsAiConnection`); somebody whose
 * organization already has an AI never sees it, and adds their own later in Settings. Until the
 * server says a connection is in use, the step's button is disabled and there is no Not now.
 *
 * THE CHOOSER IS SETTINGS' OWN, ON THE PAGE. The same provider list, ways in and checks as
 * Settings' AI connection dialog (ai-connection-chooser.tsx), in its personal mode, drawn in a card
 * where the other steps draw their picture: beside the words on a desktop, under them on a phone.
 */
export function useAiStep(): OnboardingStep {
  const personal = useQuery(personalAiConnectionQueryOptions());
  const connected = personal.data ? personal.data.uses !== "none" : false;
  return {
    id: "ai",
    title: "Connect your AI",
    /*
     * The way out sits with the words on a desktop, beside the chooser, and under the chooser on a
     * phone, where the column reads top to bottom and connecting is what the step is for. Drawn in
     * one place or the other, never both: the hidden one is `display: none`, out of reach.
     */
    intro: () => (
      <StepIntro
        after={
          <div className="max-lg:hidden">
            <WayOut />
          </div>
        }
      >
        <p>
          Bots need an AI model to work. Connect your own by signing in or with
          an API key. It's personal to you and never shared with your
          organization.
        </p>
        <p>You can change it anytime in Settings.</p>
      </StepIntro>
    ),
    demo: () =>
      personal.data ? (
        <div className="flex flex-col gap-8">
          <AiChooserPane personal={personal.data} />
          {/*
           * No room of its own below: the frame keeps the fade's height above the phone's pinned
           * buttons for every step, so scrolled to the end Sign out stops just above the fade, as
           * Welcome's and the terms step's last lines do.
           */}
          <div className="lg:hidden">
            <WayOut />
          </div>
        </div>
      ) : null,
    primaryDisabled: !connected,
  };
}

/**
 * THE WAY OUT THAT ISN'T A SKIP. Somebody in more than one organization may be here because the
 * one they are working in has no AI, while another of theirs has one for everyone: they can work
 * there instead, by the same switch as the account menu's. And anybody can sign out. Both sit with
 * the words, under the sentence, as Welcome's one setting does.
 */
function WayOut() {
  const headingId = useId();
  const choices = useOrganizationChoices();
  const switching = useSwitchOrganization();
  const signOut = useSignOut();
  const email = useQuery(currentUserQueryOptions()).data?.email;
  const others =
    choices?.organizations.filter((one) => one.id !== choices.currentId) ?? [];
  return (
    <section
      aria-label="Other ways on"
      className="flex flex-col gap-3 text-left"
    >
      {others.length > 0 ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-pretty" id={headingId}>
              Or work in another organization
            </h2>
            <p className="text-pretty text-muted-foreground">
              If one of them has an AI for everyone, Bots can use it there.
            </p>
          </div>
          <fieldset
            aria-labelledby={headingId}
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
          >
            {others.map((organization) => (
              <Item
                className="text-left"
                key={organization.id}
                render={
                  <button
                    disabled={switching.pending}
                    onClick={() => switching.run(organization.id)}
                    type="button"
                  />
                }
                size="sm"
                variant="outline"
              >
                <ItemMedia variant="icon">
                  <IconBuilding />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="[overflow-wrap:anywhere]">
                    {organization.name}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            ))}
          </fieldset>
        </>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="min-w-0 truncate">
          {email ? `Signed in as ${email}` : null}
        </span>
        <Button
          className="-me-2.5 shrink-0"
          disabled={signOut.pending}
          onClick={signOut.run}
          size="sm"
          type="button"
          variant="ghost"
        >
          {signOut.pending ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </section>
  );
}

/** The chooser, or once connected, what is connected and a way to change it. */
function AiChooserPane({ personal }: { personal: PersonalAiConnection }) {
  const [changing, setChanging] = useState(false);
  const connected = personal.uses !== "none";
  return (
    <div className="mx-auto w-full max-w-lg">
      <ChooserCard>
        {connected && !changing ? (
          <div className="flex flex-col gap-4">
            {personal.uses === "personal" ? (
              <ConnectedRow connection={personal.connection} />
            ) : (
              <p className="text-sm">
                Bots use the AI your organization set up.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Bots use it when they work for you.
            </p>
            <div className="flex justify-end">
              <Button
                onClick={() => setChanging(true)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Change
              </Button>
            </div>
          </div>
        ) : (
          <ChooseConnection
            connection={personal.connection}
            mode={{ kind: "personal", signIns: personal.signIns }}
            onBack={connected ? () => setChanging(false) : undefined}
            onConnected={() => setChanging(false)}
          />
        )}
      </ChooserCard>
    </div>
  );
}
