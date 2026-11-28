import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { useRef, useState } from "react";
import {
  Composer,
  type ComposerDraft,
  toAgentOptions,
} from "@/components/channels/composer";
import { BoxLineView } from "@/components/routines/box-line";
import { Unfold } from "@/components/routines/unfold";
import { Button } from "@/components/ui/button";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  CoworkerRoutingRefusedError,
  routeMessage,
} from "@/lib/channels/route";
import { fallbackBot, pickBotFor } from "@/lib/channels/start";
import {
  proactiveAllowedQueryOptions,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import {
  type BoxLine,
  lineForMade,
  lineForReadError,
  lineForReading,
  lineForRoutingRefusal,
  lineForUndo,
  lineForWriteError,
} from "@/lib/routines/box";
import { browserTimeZone } from "@/lib/routines/form";
import {
  createFromPlanMutationOptions,
  readRoutineSentenceMutationOptions,
  undoMadeMutationOptions,
} from "@/lib/routines/mutations";
import { planRoutine } from "@/lib/routines/plan";
import { queryClient } from "@/query-client";

/**
 * Thrown from the box's send so the Composer puts the sentence back: it clears the box as a send
 * starts and restores the words, ahead of anything typed since, when the send fails. Only a routine
 * that was made, or may have been, lets the sentence go.
 */
class KeepSentence extends Error {}

/** A Bot the shown list can't name: the line still says who took it. */
const UNNAMED_BOT = "A Bot";

/**
 * The sentence without the `@` chip that named its Bot. The Composer flattens a chip to
 * `@<name>`; the read is given the words around it, joined by one space.
 */
function withoutMention(text: string, name: string): string {
  const chip = `@${name}`;
  const at = text.indexOf(chip);
  if (at === -1) return text.trim();
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + chip.length).trimStart();
  return (before && after ? `${before} ${after}` : before + after).trim();
}

/**
 * The Routines box: Home's message box with only its `@` menu. A sentence that names a Bot with `@`
 * is for that Bot; one that names nobody goes to the Bot OpenBot picks, as Home's does. The sentence
 * is read by the server and written as a routine when it says everything one needs. Anything else is
 * said in the line under the box, in the Bot's words, with at most one way on. Pressing an example
 * only fills the box in.
 */
export function RoutineBox({
  bots,
  examples,
}: {
  /** The Bots the person can use, in their order; undefined until they are read. */
  bots: readonly AgentProfile[] | undefined;
  examples?: readonly string[];
}) {
  const read = useMutation(readRoutineSentenceMutationOptions());
  const createFromPlan = useMutation(
    createFromPlanMutationOptions(queryClient),
  );
  const undo = useMutation(undoMadeMutationOptions(queryClient));
  // The same two reads as the New routine page: both come from the one check-ins request.
  const allowed = useQuery(proactiveAllowedQueryOptions()).data === true;
  const checkIns = useQuery(proactiveSettingsQueryOptions());

  const [line, setLine] = useState<BoxLine | null>(null);
  // An example pressed: the Composer reads its words once, as it mounts, so each press is a new box.
  const [filled, setFilled] = useState<{ text: string; times: number } | null>(
    null,
  );
  // Set before the first await, so a second Enter in the same tick sends nothing; the state beside
  // it is what draws.
  const sending = useRef(false);
  const [sendingNow, setSendingNow] = useState(false);

  const busy = sendingNow || read.isPending || createFromPlan.isPending;

  const shownBot = (id: string) =>
    bots?.find((candidate) => candidate.id === id);
  const nameOf = (id: string) => shownBot(id)?.name ?? UNNAMED_BOT;

  /** Read the sentence and make what it says. True when the sentence may go from the box. */
  async function readAndMake(draft: ComposerDraft): Promise<boolean> {
    let botId: string;
    let sentence: string;
    if (draft.agentId) {
      botId = draft.agentId;
      sentence = withoutMention(draft.text, nameOf(botId));
    } else {
      try {
        botId = await pickBotFor({
          text: draft.text,
          skills: [],
          roster: bots,
          route: (text, skills) => routeMessage(text, undefined, skills),
        });
      } catch (error) {
        setLine(
          error instanceof CoworkerRoutingRefusedError
            ? lineForRoutingRefusal(error.message, fallbackBot(bots)?.id ?? "")
            : lineForReadError(error, ""),
        );
        return false;
      }
      sentence = draft.text;
    }
    // Only a Bot's name: nothing to read yet.
    if (!sentence) return false;
    const botName = nameOf(botId);

    let reading: Awaited<ReturnType<typeof read.mutateAsync>>;
    try {
      reading = await read.mutateAsync({
        botId,
        sentence,
        timezone: browserTimeZone(),
      });
    } catch (error) {
      setLine(lineForReadError(error, botId));
      return false;
    }

    const said = lineForReading(reading, {
      botId,
      botName,
      allowed,
      checkIns: checkIns.data,
    });
    if (said.kind !== "write") {
      setLine(said);
      return false;
    }

    try {
      const made = await createFromPlan.mutateAsync(
        planRoutine(said.values, said.timezone, said.cron ?? undefined),
      );
      // `said` is a write only for a ready reading, which carries the draft.
      if (reading.outcome === "ready")
        setLine(lineForMade(made, reading.draft, botId, botName));
      return true;
    } catch (error) {
      const failed = lineForWriteError(error, botId);
      setLine(failed);
      // A routine that may have been made is not sent again, so its sentence goes; any other
      // failure keeps it to try again.
      return failed.kind === "maybeMade";
    }
  }

  async function send(draft: ComposerDraft) {
    if (sending.current) throw new KeepSentence();
    sending.current = true;
    setSendingNow(true);
    setLine(null);
    let made = false;
    try {
      made = await readAndMake(draft);
    } finally {
      sending.current = false;
      setSendingNow(false);
    }
    if (!made) throw new KeepSentence();
  }

  function undoMade() {
    if (line?.kind !== "made") return;
    const { open, botId } = line;
    undo.mutateAsync(open).then(
      () => setLine(lineForUndo(botId)),
      (error: unknown) => setLine(lineForWriteError(error, botId)),
    );
  }

  if (bots && bots.length === 0) return <NoBotsYet />;

  // A line whose Bot the list can't show still has an orb: the routed Bot's own, or, when no Bot
  // was picked, the one OpenBot would have picked.
  const lineBot = line
    ? (shownBot(line.botId) ??
      (line.botId
        ? { name: UNNAMED_BOT, avatarSeed: line.botId }
        : fallbackBot(bots)))
    : null;

  return (
    <div className="flex flex-col">
      <Composer
        agents={toAgentOptions(bots)}
        className="w-full"
        commands={[]}
        dictates={false}
        disabled={!bots}
        key={filled?.times ?? 0}
        // One line, with Send beside the words, growing as they wrap.
        oneLine
        onSubmit={send}
        placeholder="@Assistant check my email every day at 9AM"
        spinsWhileSending
        // Sending waits for the check-ins read, which the rules for a check-in need.
        pending={busy || checkIns.isPending}
        {...(filled ? { initialValue: filled.text, autoFocus: true } : {})}
      />

      {/* The line opens under the box when there is something to say, and folds when it goes. */}
      <AnimatePresence initial={false}>
        {line && lineBot ? (
          <Unfold key="line">
            {/* The space above the line is inside it, so it opens with the line. */}
            <div className="pt-3">
              <BoxLineView
                bot={lineBot}
                line={line}
                onUndo={undoMade}
                undoing={undo.isPending}
              />
            </div>
          </Unfold>
        ) : null}
      </AnimatePresence>

      {examples?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {examples.map((example) => (
            <Button
              className="h-auto max-w-full whitespace-normal py-1 text-left"
              key={example}
              onClick={() =>
                setFilled((current) => ({
                  text: example,
                  times: (current?.times ?? 0) + 1,
                }))
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {example}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What the box says when there is no Bot to make a routine for. */
function NoBotsYet() {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground text-sm">
        Make a Bot first to give it routines.
      </p>
      <Button
        render={(props) => (
          <Link {...props} search={{ new: true }} to="/bots" />
        )}
        size="sm"
        variant="outline"
      >
        New Bot
      </Button>
    </div>
  );
}
