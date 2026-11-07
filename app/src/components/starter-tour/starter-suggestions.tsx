import { CopilotChatSuggestionView } from "@copilotkit/react-core/v2";
import { isStarterTourAgent } from "@openbot/shared/starter-tour";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { STARTER_SUGGESTIONS, showStarterTour } from "./suggestions";

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
    if (index === 1 && capabilities.data?.generativeUi !== true) {
      setError(
        capabilities.isPending
          ? "Still checking whether interactive answers are available. Try again in a moment."
          : "Interactive answers are disabled for this installation. Try another starter task.",
      );
      return;
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
      className="relative mb-2 w-full max-w-2xl [&>div]:gap-1 [&>div]:bg-transparent"
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
