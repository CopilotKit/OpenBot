import { IconArrowUp, IconLoader2 } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  BoxBotPicker,
  NoBotsYet,
  useBoxBot,
} from "@/components/routines/box-bot-picker";
import { BoxLineView } from "@/components/routines/box-line";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { loadFailureText } from "@/lib/load-failure";
import {
  proactiveAllowedQueryOptions,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import {
  type BoxLine,
  lineForMade,
  lineForReading,
  lineForWriteError,
} from "@/lib/routines/box";
import { browserTimeZone } from "@/lib/routines/form";
import {
  createFromPlanMutationOptions,
  readRoutineSentenceMutationOptions,
} from "@/lib/routines/mutations";
import { planRoutine } from "@/lib/routines/plan";
import { queryClient } from "@/query-client";

/** The longest sentence the server reads. */
const MAX_SENTENCE = 2000;

const SENTENCE_LABEL = "What should it do, and when?";

/**
 * The Routines box: one sentence, read by the server and written as a routine when it says
 * everything one needs. Anything else is said in the line under the box, in the Bot's words, with at
 * most one way on. Pressing an example only fills the box in.
 */
export function RoutineBox({ examples }: { examples?: readonly string[] }) {
  const box = useBoxBot();
  const read = useMutation(readRoutineSentenceMutationOptions());
  const createFromPlan = useMutation(
    createFromPlanMutationOptions(queryClient),
  );
  // The same two reads as the New routine page: both come from the one check-ins request.
  const allowed = useQuery(proactiveAllowedQueryOptions()).data === true;
  const checkIns = useQuery(proactiveSettingsQueryOptions());

  const [sentence, setSentence] = useState("");
  const [line, setLine] = useState<BoxLine | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Set before the first await, so a second Enter in the same tick sends nothing; the state beside
  // it is what draws.
  const sending = useRef(false);
  const [sendingNow, setSendingNow] = useState(false);

  const { bot, bots } = box;
  const busy = sendingNow || read.isPending || createFromPlan.isPending;
  const canSend =
    bot !== null &&
    !checkIns.isPending &&
    sentence.trim() !== "" &&
    sentence.length <= MAX_SENTENCE &&
    !busy;

  async function send() {
    if (!bot || !canSend || sending.current) return;
    sending.current = true;
    setSendingNow(true);
    const { id: botId, name: botName } = bot;
    const text = sentence;
    setLine(null);
    try {
      let reading: Awaited<ReturnType<typeof read.mutateAsync>>;
      try {
        reading = await read.mutateAsync({
          botId,
          sentence: text,
          timezone: browserTimeZone(),
        });
      } catch (error) {
        setLine({
          kind: "useForm",
          botId,
          draft: null,
          text: loadFailureText(
            error,
            (error instanceof Error && error.message) ||
              "Couldn't read that. Try again, or use the form.",
          ),
        });
        return;
      }

      const said = lineForReading(reading, {
        botId,
        botName,
        allowed,
        checkIns: checkIns.data,
      });
      if (said.kind !== "write") {
        setLine(said);
        return;
      }

      try {
        const made = await createFromPlan.mutateAsync(
          planRoutine(said.values, said.timezone, said.cron ?? undefined),
        );
        // `said` is a write only for a ready reading, which carries the draft.
        if (reading.outcome === "ready")
          setLine(lineForMade(made, reading.draft, botId, botName));
        // Only the sentence that was sent goes: anything typed meanwhile stays.
        setSentence((current) => (current === text ? "" : current));
      } catch (error) {
        const failed = lineForWriteError(error, botId);
        setLine(failed);
        // A routine that may have been made is not sent again, so its sentence goes; any other
        // failure keeps it to try again.
        if (failed.kind === "maybeMade")
          setSentence((current) => (current === text ? "" : current));
      }
    } finally {
      sending.current = false;
      setSendingNow(false);
    }
  }

  // A failed first read draws nothing; a failed refetch keeps the Bots it already has.
  if (box.isError && !box.bots) return null;
  if (box.bots && box.bots.length === 0) return <NoBotsYet />;

  const lineBot = line
    ? (bots?.find((candidate) => candidate.id === line.botId) ?? bot)
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1 rounded-full border bg-background py-1.5 pr-1.5 pl-2">
        <BoxBotPicker
          bots={bots ?? []}
          disabled={busy || !bots}
          onChange={box.pick}
          value={bot?.id ?? null}
        />
        <Textarea
          aria-label={SENTENCE_LABEL}
          className="min-h-0 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
          disabled={!bots}
          onChange={(event) => setSentence(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            )
              return;
            event.preventDefault();
            void send();
          }}
          placeholder={SENTENCE_LABEL}
          ref={textarea}
          rows={1}
          value={sentence}
        />
        <Button
          aria-label="Send"
          className="rounded-full"
          disabled={!canSend}
          onClick={() => void send()}
          size="icon"
          type="button"
        >
          {busy ? (
            <IconLoader2 className="animate-spin motion-reduce:animate-none" />
          ) : (
            <IconArrowUp />
          )}
        </Button>
      </div>

      {line && lineBot ? (
        <BoxLineView
          bot={lineBot}
          line={line}
          onDismiss={() => setLine(null)}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {examples?.map((example) => (
            <Button
              key={example}
              onClick={() => {
                setSentence(example);
                textarea.current?.focus();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {example}
            </Button>
          ))}
        </div>
        {bot ? (
          <Link
            className="text-muted-foreground text-sm"
            search={{ agentId: bot.id }}
            to="/routines/new"
          >
            Use the form
          </Link>
        ) : null}
      </div>
    </div>
  );
}
