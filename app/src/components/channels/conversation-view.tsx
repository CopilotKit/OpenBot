import type { Message } from "@ag-ui/core";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  type AgentOption,
  type CommandOption,
  Composer,
  type ComposerDraft,
} from "@/components/channels/composer";

export function ConversationView({
  messages,
  busy = false,
  notice,
  agents = [],
  commands,
  disabled = false,
  pending = false,
  onSubmit,
  onStop,
}: {
  messages: readonly Message[];
  busy?: boolean;
  /** Shown above the composer. An error, or why this conversation is read-only. */
  notice?: ReactNode;
  agents?: readonly AgentOption[];
  /**
   * The `/` menu for this Bot's granted skills, supplied by the route that owns grant loading.
   */
  commands?: readonly CommandOption[];
  disabled?: boolean;
  pending?: boolean;
  onSubmit: (draft: ComposerDraft) => void | Promise<void>;
  /** Stop the Bot mid-answer; forwarded to turn the send button into a stop button. */
  onStop?: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-1 min-h-0">
        {/*
         * The command NAMES, joined, rather than the option objects.
         *
         * The transcript needs them only to tell a real skill chip from a message that happens to
         * begin with a slash, and its message rows are memoised on primitives — handing them an
         * array would give every message a new prop identity on each refetch and re-render the whole
         * conversation to change nothing.
         */}
        <ChatTranscript
          busy={busy}
          commandNames={(commands ?? [])
            .map((command) => command.name)
            .join(",")}
          messages={messages}
        />
      </div>
      <div className="max-w-2xl mx-auto w-full px-0 pb-4 shrink-0">
        {notice}
        <Composer
          agents={agents}
          {...(commands ? { commands } : {})}
          className="w-full mt-auto"
          compact
          disabled={disabled}
          onStop={onStop}
          onSubmit={onSubmit}
          pending={pending}
        />
      </div>
    </div>
  );
}
