import { CopilotChatSuggestionView } from "@copilotkit/react-core/v2";
import { isStarterTourAgent } from "@openbot/shared/starter-tour";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  saveUserPreferencesMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";
import { mayOpenSetup, setupChecklistQueryOptions } from "@/lib/setup/queries";
import { showStarterTour, STARTER_SUGGESTIONS } from "./suggestions";

type Props = {
  agentId: string | undefined;
  channelId?: string;
  disabled?: boolean;
  onSelect: (message: string) => unknown | Promise<unknown>;
};

/** Independent of the Bot's name, harness attribution and conversation introduction. */
export function StarterSuggestions(props: Props) {
  if (!props.agentId || !isStarterTourAgent(props.agentId)) return null;
  return <EligibleStarterSuggestions {...props} />;
}

function EligibleStarterSuggestions(props: Props) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const preferences = useQuery({
    ...userPreferencesQueryOptions(user?.id),
    // A tour dismissed or claimed in another window must not repeat on return.
    refetchOnWindowFocus: true,
  });
  if (
    !user ||
    !preferences.data ||
    !showStarterTour(preferences.data, props.channelId)
  )
    return null;
  return <StarterSuggestionChoices {...props} userId={user.id} />;
}

function StarterSuggestionChoices({
  onSelect,
  disabled = false,
  userId,
}: Props & { userId: string }) {
  const client = useQueryClient();
  const dismiss = useMutation(
    saveUserPreferencesMutationOptions(client, userId),
  );
  const { data: user } = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const setup = useQuery(setupChecklistQueryOptions());
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  const choose = async (index: number) => {
    if (disabled || sendingRef.current || dismiss.isPending) return;
    setError(null);
    setNeedsSetup(false);
    if (index === 1 && capabilities.data?.generativeUi !== true) {
      setError(
        capabilities.isPending
          ? "Still checking whether interactive answers are available. Try again in a moment."
          : "Interactive answers aren't available right now. Check your setup before trying this task.",
      );
      setNeedsSetup(!capabilities.isPending);
      return;
    }
    if (index === 3 || index === 4) {
      const computer = setup.data?.rows.find((row) => row.id === "computer");
      // A configured but unused computer starts on the first browser request.
      // "not_checked" is not a setup failure; blocking it prevents that first use.
      if (computer?.ready !== true && computer?.status !== "not_checked") {
        setError(
          setup.isPending
            ? "Still checking the Bot's browser. Try again in a moment."
            : "The Bot's browser isn't ready. Check your setup before trying this task.",
        );
        setNeedsSetup(!setup.isPending);
        return;
      }
    }
    const suggestion = STARTER_SUGGESTIONS[index];
    if (!suggestion) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onSelect(suggestion.message);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't start that task. Try again.",
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <section
      aria-label="Starter tasks"
      className="mb-3 w-full max-w-2xl rounded-xl border border-border bg-card p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Try something useful</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({ starterTourDismissed: true })}
        >
          Hide starter tasks
        </Button>
      </div>
      <CopilotChatSuggestionView
        suggestions={STARTER_SUGGESTIONS}
        suggestion={{ disabled: disabled || sending || dismiss.isPending }}
        onSelectSuggestion={(_suggestion, index) => {
          void choose(index);
        }}
      />
      {error || dismiss.error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error ?? dismiss.error?.message}
          {needsSetup ? (
            mayOpenSetup(user ?? undefined, capabilities.data) ? (
              <>
                {" "}
                <Link className="underline" to="/settings/setup">
                  Check setup
                </Link>
              </>
            ) : (
              " Ask your admin to check the setup."
            )
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
