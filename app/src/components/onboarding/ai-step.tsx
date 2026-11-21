import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
    intro: () => (
      <StepIntro>
        <p>
          Bots need an AI model to work. Connect your own by signing in or with
          an API key. It's personal to you and never shared with your
          organization.
        </p>
        <p>You can change it anytime in Settings.</p>
      </StepIntro>
    ),
    demo: () =>
      personal.data ? <AiChooserPane personal={personal.data} /> : null,
    primaryDisabled: !connected,
  };
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
