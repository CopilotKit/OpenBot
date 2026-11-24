import { IconListNumbers, IconLock, IconRobot } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { SettingsToolCardProps } from "./registry";
import { ScreenLink } from "./screen-link";
import { SettingsReadCard } from "./settings-read-card";

/**
 * `how_do_i`: how the person does something in OpenBot themselves, click by click. A person asked
 * their Bot how to give one of their Bots a permission, and the Bot said it couldn't see its own
 * screens. The server now says where each job is done and how; this draws it.
 *
 * Each answer is a numbered list: the clicks that open the screen, then the job on it, with the
 * words on the screen in bold as the server marks them. Then a link that opens the screen, where it
 * can be linked. The card is titled with the first answer's job; up to two more are stacked under
 * it, each titled with its own.
 */

type Answer = {
  task: string;
  screen: { title: string; path: string | null };
  steps: string[];
  tool: string | null;
};

/** At most this many answers are drawn: the first and two more. */
const MOST_ANSWERS = 3;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];

/** The answers as the server sent them, each with the clicks to open its screen and then the job. */
export function howDoIAnswers(
  output: Record<string, unknown> | null,
): Answer[] {
  const answers = Array.isArray(output?.answers) ? output.answers : [];
  return answers
    .flatMap((value): Answer[] => {
      if (!value || typeof value !== "object") return [];
      const answer = value as Record<string, unknown>;
      if (typeof answer.task !== "string") return [];
      const screen =
        answer.screen && typeof answer.screen === "object"
          ? (answer.screen as Record<string, unknown>)
          : {};
      return [
        {
          task: answer.task,
          screen: {
            title: typeof screen.title === "string" ? screen.title : "",
            // Only OpenBot's own screens become links.
            path:
              typeof screen.path === "string" && screen.path.startsWith("/")
                ? screen.path
                : null,
          },
          steps: [...strings(answer.open), ...strings(answer.steps)],
          tool: typeof answer.tool === "string" ? answer.tool : null,
        },
      ];
    })
    .slice(0, MOST_ANSWERS);
}

/**
 * A step as the server writes it, with the words on the screen in `**bold**`: those words are
 * strong, and nothing else is read as markdown. An asterisk pair with no partner is dropped, so a
 * person never sees one.
 */
export function StepWords({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const bold = /\*\*(.+?)\*\*/g;
  let from = 0;
  for (const match of text.matchAll(bold)) {
    const at = match.index ?? 0;
    if (at > from) parts.push(text.slice(from, at).replaceAll("**", ""));
    parts.push(
      <strong className="font-medium text-foreground" key={at}>
        {match[1]}
      </strong>,
    );
    from = at + match[0].length;
  }
  if (from < text.length) parts.push(text.slice(from).replaceAll("**", ""));
  return <>{parts}</>;
}

/** One answer: its steps in order, numbered, then the screen to open. */
function Steps({ answer }: { answer: Answer }) {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2.5 text-sm" data-steps>
        {answer.steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed list in order, and two may read alike.
          <li className="flex items-start gap-2.5" data-step key={index}>
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs tabular-nums"
            >
              {index + 1}
            </span>
            <span className="min-w-0 break-words pt-px text-pretty">
              <StepWords text={step} />
            </span>
          </li>
        ))}
      </ol>
      {answer.tool ? (
        <p
          className="flex items-start gap-1.5 text-muted-foreground text-xs"
          data-bot-can
        >
          <IconRobot aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>Or ask your Bot to do it for you.</span>
        </p>
      ) : null}
      {answer.screen.path && answer.screen.title ? (
        <ScreenLink
          label={`Open ${answer.screen.title}`}
          to={answer.screen.path}
        />
      ) : null}
    </div>
  );
}

export function HowDoICard({
  args,
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const answers = howDoIAnswers(output);
  const [first, ...more] = answers;
  const adminsOnly =
    typeof output?.adminsOnly === "string" && output.adminsOnly.trim()
      ? output.adminsOnly
      : null;
  // Before the answer, the job as the Bot asked it.
  const asked =
    typeof args.task === "string" && args.task.trim()
      ? args.task.trim().charAt(0).toUpperCase() + args.task.trim().slice(1)
      : null;
  return (
    <SettingsReadCard
      caption={
        answers.length > 1
          ? "Here's how to do each one yourself."
          : "Here's how to do it yourself."
      }
      icon={IconListNumbers}
      state={state}
      title={first?.task ?? asked ?? "How to do it"}
      wrapTitle
      {...(reason ? { reason } : {})}
    >
      {first ? (
        <div className="flex flex-col gap-4" data-answers>
          <section className="flex flex-col" data-answer={first.task}>
            <Steps answer={first} />
          </section>
          {more.map((answer) => (
            <section
              className="flex flex-col gap-2.5 border-border border-t pt-4"
              data-answer={answer.task}
              key={answer.task}
            >
              <h3 className="font-medium text-sm">{answer.task}</h3>
              <Steps answer={answer} />
            </section>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          There's no screen for that you can open.
        </p>
      )}
      {adminsOnly ? (
        <p
          className="flex items-start gap-1.5 text-muted-foreground text-xs"
          data-admins-only
        >
          <IconLock aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{adminsOnly}</span>
        </p>
      ) : null}
    </SettingsReadCard>
  );
}
