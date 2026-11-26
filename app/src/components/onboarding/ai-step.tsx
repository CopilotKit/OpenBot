import { IconBuilding, IconChevronRight } from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import {
  ChooseConnection,
  ChooserCard,
  ConnectedRow,
} from "@/components/settings/ai-connection-chooser";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { providerById } from "@/lib/ai-connection/providers";
import {
  type AiConnections,
  aiConnectionsQueryOptions,
  type PersonalAiConnection,
  personalAiConnectionInQueryOptions,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import type { AiConnection } from "@/lib/api/generated/model";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useOrganizationChoices } from "@/lib/organizations/queries";
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
 * Settings → AI providers → Connect another AI (ai-connection-chooser.tsx), drawn in a card where the
 * other steps draw their picture: beside the words on a desktop, under them on a phone.
 *
 * SEVERAL, ONE AFTER ANOTHER. Each connection brings the person back to the list, where what they
 * connected has a check, so they can connect another or go on. One is enough to go on; the first is
 * the default (the server's rule), and which one is the default is changed in Settings.
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
          Bots need an AI model to work. Connect one or more by signing in or
          with an API key. They're personal to you and never shared with your
          organization.
        </p>
        <p>You can add more or change them anytime in Settings.</p>
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
 *
 * ONLY AN ORGANIZATION WITH AN AI FOR EVERYONE IS OFFERED, by what the server says of each at its
 * own address. Offering every other one sent people round between organizations that all had no
 * AI, held at this step in each (reported on 1.2.0-rc.2). The list waits for every answer, so it
 * is drawn once and never grows row by row; one that can't be read is left out.
 */
function WayOut() {
  const headingId = useId();
  const choices = useOrganizationChoices();
  const switching = useSwitchOrganization();
  const signOut = useSignOut();
  const email = useQuery(currentUserQueryOptions()).data?.email;
  const elsewhere =
    choices?.organizations.filter((one) => one.id !== choices.currentId) ?? [];
  const answers = useQueries({
    queries: elsewhere.map((one) => personalAiConnectionInQueryOptions(one.id)),
  });
  const others = answers.some((answer) => answer.isPending)
    ? []
    : elsewhere.filter(
        (_, at) => answers[at]?.data?.organization.ready === true,
      );
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
              Bots can use the AI set up for everyone there.
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

/**
 * The person's own connections, as a list to add to. A server older than several connections (404),
 * or one where a person can't have their own (409), answers no list: the one connection's chooser,
 * as before.
 */
function AiChooserPane({ personal }: { personal: PersonalAiConnection }) {
  const list = useQuery(aiConnectionsQueryOptions("personal"));
  if (list.isPending) return null;
  // Keep an open form mounted if refreshing its cached list fails.
  if (list.isLoadingError)
    return (
      <div className="mx-auto w-full max-w-lg">
        <ChooserCard>
          <div className="flex flex-col gap-4">
            <p className="text-destructive text-sm" role="alert">
              Couldn't load your AI connections. Try again.
            </p>
            <div className="flex justify-end">
              <Button
                disabled={list.isFetching}
                onClick={() => void list.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </div>
          </div>
        </ChooserCard>
      </div>
    );
  return list.data ? (
    <SeveralPane list={list.data} />
  ) : (
    <OnePane personal={personal} />
  );
}

/**
 * The provider list, with a check on each one connected. Connecting goes back to the list: the
 * chooser is drawn again from the list the connection refreshed (its mutation waits for that), and
 * a line only a screen reader hears says what was connected, since the form it was in is gone.
 */
function SeveralPane({ list }: { list: AiConnections }) {
  const [lastConnected, setLastConnected] = useState<{
    provider: AiConnection["provider"];
    round: number;
  }>();
  const name = lastConnected
    ? (providerById(lastConnected.provider)?.name ?? "Your AI")
    : null;
  return (
    <div className="mx-auto w-full max-w-lg">
      <ChooserCard>
        <ChooseConnection
          key={lastConnected?.round ?? 0}
          initialFocusProvider={lastConnected?.provider ?? undefined}
          mode={{
            kind: "adding",
            scope: "personal",
            signIns: list.signIns,
            connected: list.connections,
          }}
          onConnected={({ connection }) =>
            setLastConnected((previous) => ({
              provider: connection.provider,
              round: (previous?.round ?? 0) + 1,
            }))
          }
        />
      </ChooserCard>
      <p aria-live="polite" className="sr-only" role="status">
        {name ? `${name} is connected.` : ""}
      </p>
    </div>
  );
}

/** The one connection's chooser, or once connected, what is connected and a way to change it. */
function OnePane({ personal }: { personal: PersonalAiConnection }) {
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
