import { CopilotChatSuggestionView } from "@copilotkit/react-core/v2";
import { isStarterTourAgent } from "@openbot/shared/starter-tour";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import {
  INTERACTIVE_STARTER,
  STARTER_SUGGESTIONS,
  showStarterTour,
} from "./suggestions";

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
    // A tour claimed in another window must not repeat on return.
    refetchOnWindowFocus: true,
  });
  if (
    !user ||
    !preferences.data ||
    !showStarterTour(preferences.data, props.channelId)
  )
    return null;
  return <StarterSuggestionChoices {...props} />;
}

function StarterSuggestionChoices({ onSelect, disabled = false }: Props) {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (index: number) => {
    if (disabled || sendingRef.current) return;
    setError(null);
    const suggestion = STARTER_SUGGESTIONS[index];
    if (!suggestion) return;
    if (
      suggestion === INTERACTIVE_STARTER &&
      capabilities.data?.generativeUi !== true
    ) {
      setError(
        capabilities.isPending
          ? "Still checking whether interactive answers are available. Try again in a moment."
          : "Interactive answers are disabled for this installation. Try another starter task.",
      );
      return;
    }
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
    /*
     * Inset by the composer's own padding (`px-3`), so the first task lines up with "Ask anything"
     * rather than with the composer's border. In a window narrower than the conversation column the
     * composer runs to the pane's edge, and with no inset the first task sat on that edge too, its
     * border lost in the pane's. `mb-3` is the app's gap between stacked controls; the 8px it had
     * read as the row sitting on the composer.
     */
    <section
      aria-label="Starter tasks"
      className="relative mb-3 w-full max-w-2xl px-3 [&>div]:gap-1 [&>div]:bg-transparent"
    >
      <CopilotChatSuggestionView
        suggestions={STARTER_SUGGESTIONS}
        suggestion={{
          disabled: disabled || sending,
          className:
            "px-2 py-1 text-xs leading-4 text-muted-foreground bg-transparent",
        }}
        onSelectSuggestion={(_suggestion, index) => {
          void choose(index);
        }}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
