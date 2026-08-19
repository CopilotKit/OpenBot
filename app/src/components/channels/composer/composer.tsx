import {
  IconArrowUp,
  IconPlayerStopFilled,
  IconPlus,
} from "@tabler/icons-react";
import { PromptArea, type PromptAreaHandle } from "prompt-area";
import type { Segment } from "prompt-area/helpers";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import {
  applyCommandChips,
  type CommandOption,
  type ComposerDraft,
  enforceSingleAgent,
  toDraft,
} from "./draft";
import { PLACEHOLDER_COMMANDS } from "./sources";
import { type AgentOption, buildTriggers } from "./triggers";

const MAX_HEIGHT_PX = 220;
/**
 * Tracks the compact `text-sm` line box so PromptArea stays vertically centered in one row.
 */
const COMPACT_MIN_HEIGHT_PX = 19;
const COMPACT_MAX_HEIGHT_PX = 96;

export type ComposerProps = {
  className?: string;
  compact?: boolean;
  /** Agents that `@` can address. Empty means the mention menu reports an empty channel. */
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  /**
   * Receives the whole draft rather than a string, so a mention or a command reaches the caller as
   * structured data instead of something it would have to re-parse out of the text.
   */
  onSubmit?: (draft: ComposerDraft) => void | Promise<void>;
  /** Stop the Bot mid-answer; while pending, the send button becomes a stop button. */
  onStop?: () => void;
  /**
   * The conversation cannot take another message at all, which is a property of the conversation
   * rather than of the moment: a channel whose coworker was deleted. This is the only thing that
   * stops a person typing.
   */
  disabled?: boolean;
  /**
   * A run is in flight. It gates sending, not writing: a channel is `pending` while it is still
   * connecting and restoring its history, and the composer is on screen throughout.
   */
  pending?: boolean;
};

export function Composer({
  className,
  compact = false,
  agents = [],
  commands = PLACEHOLDER_COMMANDS,
  onSubmit,
  onStop,
  disabled = false,
  pending = false,
}: ComposerProps) {
  const [value, setValue] = useState<Segment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  /** A send has completed and the caret is owed back, as soon as the editor will take it. */
  const wantsFocus = useRef(false);

  const isBusy = pending || isSubmitting;
  const triggers = useMemo(
    () => buildTriggers({ agents, commands }),
    [agents, commands],
  );
  const draft = useMemo(() => toDraft(value), [value]);

  const handleChange = useCallback(
    (next: Segment[]) => {
      const { segments, actions } = applyCommandChips(
        enforceSingleAgent(next),
        commands,
      );
      setValue(segments);
      // Run after the commit so an action that navigates or opens a panel is not fighting the
      // editor's own state update for the same tick.
      for (const action of actions) {
        action();
      }
    },
    [commands],
  );

  /**
   * The single submit path for Enter, the send button, and the form.
   *
   * `submitInFlight` is a ref rather than `isSubmitting` because a second Enter can land before
   * React has re-rendered with the new state, which would send the message twice.
   */
  const submitDraft = useCallback(
    async (segments: Segment[]) => {
      const submitted = toDraft(segments);
      if (
        submitted.isEmpty ||
        disabled ||
        isBusy ||
        submitInFlight.current ||
        !onSubmit
      ) {
        return;
      }

      submitInFlight.current = true;
      setIsSubmitting(true);
      // Clear optimistically; restore if the send fails before becoming a message.
      setValue([]);
      try {
        await onSubmit(submitted);
      } catch (error) {
        setValue(segments);
        throw error;
      } finally {
        submitInFlight.current = false;
        setIsSubmitting(false);
        // Asked for here, performed in the effect below, which runs after the commit that clears
        // `isSubmitting` and so after the render the caret would otherwise be placed against.
        wantsFocus.current = true;
      }
    },
    [disabled, isBusy, onSubmit],
  );

  /**
   * Put the caret back the moment the composer can accept it again.
   *
   * Keyed off the editor becoming interactive rather than off the send resolving, so it survives
   * whatever the parent does with `pending` in between — and it runs after the commit, which is the
   * only point at which the element is enabled and focusable.
   */
  useEffect(() => {
    if (!wantsFocus.current || disabled || isBusy) {
      return;
    }
    wantsFocus.current = false;
    promptAreaRef.current?.focus();
  }, [disabled, isBusy]);

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft(value);
  };

  const canSend = !disabled && !isBusy && !draft.isEmpty;
  /** Stop is available only once the agent run is actually pending. */
  const canStop = Boolean(onStop) && pending;

  if (compact) {
    return (
      <form
        aria-busy={isBusy}
        className={cn(
          /*
           * `py-3` IS LOAD-BEARING ONCE THE TEXT WRAPS. On one line `min-h-14` and `items-center`
           * fake the vertical padding, so it read as correct for as long as nobody typed a
           * paragraph. Past that the row grows to fit its content exactly and the glyphs sit
           * against the border.
           *
           * It goes on the form rather than on the editor because the editor scrolls internally at
           * COMPACT_MAX_HEIGHT_PX: padding inside that box would scroll away with the text, so the
           * first visible line would still touch the top edge on a long message.
           */
          "flex min-h-14 items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          className,
        )}
        onSubmit={handleFormSubmit}
      >
        <Button
          aria-label="More message options unavailable"
          className="disabled:opacity-100"
          disabled
          size="icon"
          type="button"
          variant="ghost"
        >
          <IconPlus className="size-5" />
        </Button>
        <PromptArea
          aria-label="Message"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none"
          disabled={disabled}
          maxHeight={COMPACT_MAX_HEIGHT_PX}
          minHeight={COMPACT_MIN_HEIGHT_PX}
          onChange={handleChange}
          onSubmit={submitDraft}
          placeholder="Ask anything"
          ref={promptAreaRef}
          triggers={triggers}
          value={value}
        />
        {canStop ? (
          <Button
            aria-label="Stop the Bot"
            className="size-8 rounded-full p-0"
            data-testid="composer-stop"
            onClick={onStop}
            size="icon"
            type="button"
          >
            <IconPlayerStopFilled className="size-3" />
          </Button>
        ) : (
          <Button
            aria-label="Send message"
            className="size-8 rounded-full p-0"
            disabled={!canSend}
            size="icon"
            type="submit"
          >
            <IconArrowUp className="size-3.5" />
          </Button>
        )}
      </form>
    );
  }

  return (
    <div className={cn("w-xl", className)}>
      <form
        aria-busy={isBusy}
        className="overflow-hidden rounded-2xl border border-border bg-card"
        onSubmit={handleFormSubmit}
      >
        <input className="sr-only" multiple onChange={() => {}} type="file" />

        <div className="grow px-3 pt-3 pb-2">
          <PromptArea
            aria-label="Message"
            autoGrow
            className="w-full border-0 bg-transparent p-0 text-sm shadow-none"
            disabled={disabled}
            maxHeight={MAX_HEIGHT_PX}
            onChange={handleChange}
            onSubmit={submitDraft}
            placeholder="Ask anything"
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
        </div>

        <div className="mb-2 flex items-center justify-between px-2">
          <div />

          <div>
            {canStop ? (
              <Button
                aria-label="Stop the Bot"
                className="size-7 rounded-full bg-primary p-0"
                data-testid="composer-stop"
                onClick={onStop}
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label="Send message"
                className="size-7 rounded-full bg-primary p-0 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSend}
                type="submit"
              >
                <IconArrowUp className="size-3.5 fill-primary" />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
