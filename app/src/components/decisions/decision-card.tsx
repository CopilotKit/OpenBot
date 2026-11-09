import { IconCheck } from "@tabler/icons-react";
import { type RegisterableHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useId, useRef, useState } from "react";
import { Badge, type Tone } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useNewestDecision } from "./newest-decision";

/** One answer a person can give. */
export type DecisionOption = {
  value: string;
  label: string;
  /** What picking it does, in a line. */
  description?: string;
};

/** The answer, once given: drawn as one line where the choices were. */
export type DecisionAnswer = {
  /** The badge: "Approved", "Declined", "Answered". */
  label: string;
  /** The line under it, when it says more than the badge: the option picked, in its own words. */
  choice?: string;
  /** Words the person typed with it, if any. */
  note?: string;
  tone: Tone;
};

/** The value the "something else" row submits. */
export const OTHER = "__other__";

const COLLAPSE_SECONDS = 0.22;

/**
 * A card that waits on a person's answer: a Bot's question, a Bot asking for approval, or OpenBot
 * asking before a Bot uses an app.
 *
 * Laid out as T3 Code lays out its questions: the answers are rows, each with what it does under
 * it, the first picked to start with, and one button at the bottom right that sends the picked one
 * and is named for it, so it always says what pressing it will do. Where the Bot can take words
 * instead of a choice, the last row is a field for them.
 *
 * THE KEYBOARD. 1 to 9 pick a row and Enter sends it, as in T3 Code, but only on the newest card
 * that is waiting (`useNewestDecision`), so two cards never both take a key, and never while the
 * person is typing somewhere (TanStack's single-key hotkeys skip inputs and contenteditable, so
 * the message box keeps every digit). The rows are native radios, so Up and Down move between them.
 *
 * ANSWERING FOLDS THE CARD. The rows and the button close up and the answer takes their place as one
 * line, so a conversation that asked ten things does not stay ten cards tall. Shown already folded
 * when the card is drawn answered (`initial={false}`), and without movement for anybody who asked
 * for less of it.
 */
export function DecisionCard({
  title,
  caption,
  children,
  options,
  other,
  answer,
  onSubmit,
  submitting = false,
  error,
}: {
  title: string;
  /** One line under the title: why this is being asked. */
  caption?: ReactNode;
  /** What the person needs to decide, between the header and the answers. */
  children?: ReactNode;
  options: DecisionOption[];
  /** Offer a last row for words instead of a choice. */
  other?: { placeholder: string };
  /** Set once answered. */
  answer?: DecisionAnswer;
  onSubmit: (value: string, text: string) => void;
  /** An answer is on its way: everything holds still. */
  submitting?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const [picked, setPicked] = useState(options[0]?.value ?? OTHER);
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);
  const waiting = !answer;
  const keyed = useNewestDecision(id, waiting && !submitting);

  const values = [...options.map((option) => option.value)];
  if (other) values.push(OTHER);
  const pickedOption = options.find((option) => option.value === picked);
  const canSend = !submitting && (picked !== OTHER || text.trim().length > 0);
  const send = () => {
    if (canSend) onSubmit(picked, picked === OTHER ? text.trim() : "");
  };
  const pick = (value: string) => {
    setPicked(value);
    if (value === OTHER) field.current?.focus();
  };

  useHotkeys(
    [
      ...values.slice(0, 9).map((value, index) => ({
        hotkey: String(index + 1) as RegisterableHotkey,
        callback: () => pick(value),
      })),
      {
        hotkey: "Enter" as RegisterableHotkey,
        /*
         * Only when nothing else has focus, or this card does. Enter on a focused link or button
         * elsewhere is that control's, and must not answer a card the person is not looking at.
         */
        callback: (event) => {
          const focused = document.activeElement;
          if (
            focused &&
            focused !== document.body &&
            !card.current?.contains(focused)
          )
            return;
          event.preventDefault();
          send();
        },
        options: { preventDefault: false },
      },
    ],
    { enabled: keyed, conflictBehavior: "allow" },
  );

  const fold = {
    duration: reduceMotion ? 0 : COLLAPSE_SECONDS,
    ease: EASE_OUT,
  };

  return (
    <figure
      ref={card}
      className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
      data-slot="decision-card"
    >
      <figcaption className="flex items-start gap-4 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{title}</p>
          {caption ? (
            <p className="mt-0.5 text-muted-foreground text-xs">{caption}</p>
          ) : null}
        </div>
        {/* Swapped in place, so the badge's change of word is the only thing that moves. */}
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            animate={{ opacity: 1, scale: 1 }}
            // The title's line height, centred, so the badge sits level with the title.
            className="flex h-5 shrink-0 items-center"
            exit={{ opacity: 0, scale: 0.9 }}
            initial={{ opacity: 0, scale: 0.9 }}
            key={answer ? "answered" : "waiting"}
            transition={fold}
          >
            {answer ? (
              <Badge tone={answer.tone}>{answer.label}</Badge>
            ) : (
              <Badge tone="caution">Waiting on you</Badge>
            )}
          </motion.span>
        </AnimatePresence>
      </figcaption>

      <AnimatePresence initial={false}>
        {waiting ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            key="choices"
            style={{ overflow: "hidden" }}
            transition={fold}
          >
            {children ? <div className="px-4 pb-3">{children}</div> : null}
            {/*
             * Native radios, one group per card, styled as rows: the browser gives them the radio
             * group's keys (Tab to the picked row, Up and Down to move) and screen readers name
             * them as choices.
             */}
            {/* A fieldset is as wide as its longest word unless told otherwise, which clipped a long link. */}
            <fieldset
              aria-label={title}
              className="min-w-0 border-border border-t"
            >
              {options.map((option, index) => (
                <label
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-3 border-border border-b px-4 py-2.5 transition-colors duration-150 has-[:focus-visible]:bg-foreground/5",
                    picked === option.value
                      ? "bg-primary/[0.06]"
                      : "hover:bg-foreground/[0.03]",
                  )}
                  key={option.value}
                >
                  <input
                    // Named for the answer, with what it does read after it.
                    aria-describedby={
                      option.description ? `${id}-${index}` : undefined
                    }
                    aria-label={option.label}
                    checked={picked === option.value}
                    className="peer sr-only"
                    disabled={submitting}
                    name={id}
                    onChange={() => pick(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <Dot on={picked === option.value} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-sm">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span
                        className="mt-0.5 block break-words text-muted-foreground text-xs"
                        id={`${id}-${index}`}
                      >
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  <Key index={index} />
                </label>
              ))}
              {other ? (
                <div
                  className={cn(
                    "flex w-full items-center gap-3 border-border border-b px-4 py-2.5 transition-colors duration-150",
                    picked === OTHER && "bg-primary/[0.06]",
                  )}
                >
                  <input
                    aria-label={other.placeholder}
                    checked={picked === OTHER}
                    className="peer sr-only"
                    disabled={submitting}
                    name={id}
                    onChange={() => pick(OTHER)}
                    type="radio"
                    value={OTHER}
                  />
                  <Dot on={picked === OTHER} />
                  <input
                    aria-label="Your answer"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    disabled={submitting}
                    onChange={(event) => setText(event.target.value)}
                    onFocus={() => setPicked(OTHER)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        send();
                      }
                    }}
                    placeholder={other.placeholder}
                    ref={field}
                    value={text}
                  />
                  <Key index={values.length - 1} />
                </div>
              ) : null}
            </fieldset>
            {error ? (
              <p className="px-4 pt-2 text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end px-4 py-2.5">
              <Button disabled={!canSend} onClick={send}>
                {submitting
                  ? "Sending…"
                  : picked === OTHER
                    ? "Send"
                    : (pickedOption?.label ?? "Send")}
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {answer ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            initial={{ height: 0, opacity: 0 }}
            key="answer"
            style={{ overflow: "hidden" }}
            transition={{ ...fold, delay: reduceMotion ? 0 : 0.06 }}
          >
            <p className="flex min-w-0 items-center gap-2 border-border border-t px-4 py-2.5 text-sm">
              <IconCheck
                aria-hidden
                className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
              <span className="font-medium">
                {answer.choice ?? answer.label}
              </span>
              {answer.note ? (
                <span className="min-w-0 truncate text-muted-foreground">
                  “{answer.note}”
                </span>
              ) : null}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </figure>
  );
}

/** The radio's dot: a ring, filled in on the picked row. */
function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 size-3.5 shrink-0 rounded-full border transition-[border-width,border-color] duration-150",
        on ? "border-[4.5px] border-primary" : "border-foreground/25",
      )}
    />
  );
}

/** The digit that picks a row. Hidden from screen readers: the row is already a radio. */
function Key({ index }: { index: number }) {
  if (index > 8) return null;
  return (
    <kbd
      aria-hidden
      className="ml-auto shrink-0 px-1 font-mono text-muted-foreground text-xs leading-5"
    >
      {index + 1}
    </kbd>
  );
}
