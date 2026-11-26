/**
 * The questions a Bot asks with a card (askApproval, askChoice, askForm), drawn read-only: what it
 * asked, the answers it offered, and what was answered when the conversation says. A run started from
 * the phone never asks one of these (it asks for an approval instead), so the phone only shows them.
 */
import { View } from "react-native";
import { BotMarkdown } from "../components/bot-markdown";
import { cn } from "../components/cn";
import { Icon } from "../components/icon";
import { Text } from "../components/text";
import { IconCheck, IconClock } from "../icons";
import { type Answer, byPosition } from "./drawn";
import { GalleryFrame, list, plain, Quiet, record, str } from "./frame";

/** Where the question stands: still open, over (and so answered), or the reply stopped before it was. */
export type Asked = "waiting" | "done" | "stopped";

type DecisionArgs = {
  args: Record<string, unknown>;
  arriving: boolean;
  answer?: Answer;
  asked: Asked;
};

/** The line under a question: what was answered, or that it waits. */
function Outcome({ said, asked }: { said?: string; asked: Asked }) {
  const line =
    said ??
    (asked === "waiting"
      ? "Waiting for an answer. Answer it in OpenBot on your computer."
      : asked === "stopped"
        ? "Not answered."
        : "Answered.");
  return (
    <View className="mt-3 flex-row items-start gap-2 border-border border-t pt-3">
      <View className="pt-0.5">
        <Icon
          icon={said || asked === "done" ? IconCheck : IconClock}
          size={14}
          color="accent-muted"
        />
      </View>
      <Text tone="muted" className="flex-1 text-sm leading-5">
        {line}
      </Text>
    </View>
  );
}

/** One answer the Bot offered, marked when it is the one picked. */
function Offered({
  label,
  description,
  picked,
}: {
  label: string;
  description?: string;
  picked?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={[label, description, picked ? "Chosen" : undefined]
        .filter(Boolean)
        .join(". ")}
      className={cn(
        "flex-row items-start gap-2 rounded-lg border px-3 py-2",
        picked ? "border-foreground/40" : "border-border",
      )}
    >
      <View className="flex-1">
        <Text className={cn("text-sm leading-5", picked && "font-medium")}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        ) : null}
      </View>
      {picked ? <Icon icon={IconCheck} size={16} /> : null}
    </View>
  );
}

function Preparing({ title, what }: { title?: string; what: string }) {
  return (
    <GalleryFrame title={title ?? "Waiting for the Bot…"}>
      <Quiet>{what}</Quiet>
    </GalleryFrame>
  );
}

export function ApprovalCard({ args, arriving, answer, asked }: DecisionArgs) {
  const title = str(args.title);
  if (arriving && !title) return <Preparing what="Preparing the request…" />;
  const approve = str(args.approveLabel) ?? "Approve";
  const decline = str(args.rejectLabel) ?? "Decline";
  const command = str(args.command)?.trim() || undefined;
  const details = list(args.details)
    .map(record)
    .filter((detail) => !command || str(detail.value)?.trim() !== command);
  const decided = answer?.kind === "approval" ? answer : undefined;
  const summary = str(args.summary);
  return (
    <GalleryFrame title={title}>
      {summary ? <BotMarkdown text={summary} /> : null}
      {command || details.length ? (
        <View className="mt-3 gap-1.5 rounded-lg bg-fill px-3 py-2">
          {command ? (
            <View className="flex-row gap-3">
              <Text tone="muted" className="w-24 text-sm leading-5">
                Command
              </Text>
              <Text selectable className="flex-1 text-sm leading-5">
                {command}
              </Text>
            </View>
          ) : null}
          {byPosition(details).map(({ item, key }) => (
            <View key={key} className="flex-row gap-3">
              <Text
                tone="muted"
                numberOfLines={2}
                className="w-24 text-sm leading-5"
              >
                {plain(item.label)}
              </Text>
              <Text selectable className="flex-1 text-sm leading-5">
                {plain(item.value)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View className="mt-3 gap-2">
        <Offered label={approve} picked={decided?.decision === "approved"} />
        <Offered label={decline} picked={decided?.decision === "declined"} />
      </View>
      <Outcome
        asked={asked}
        said={
          decided?.decision === "approved"
            ? `Approved: ${approve}.`
            : decided?.decision === "declined"
              ? `Declined: ${decline}.`
              : decided
                ? `Answered: ${decided.note ?? "something else"}.`
                : undefined
        }
      />
    </GalleryFrame>
  );
}

export function ChoiceCard({ args, arriving, answer, asked }: DecisionArgs) {
  const title = str(args.title);
  if (arriving && !title) return <Preparing what="Preparing the question…" />;
  const options = list(args.options)
    .map(record)
    .map((option) => ({
      id: str(option.id),
      label: str(option.label) ?? str(option.id) ?? "",
      description: str(option.description),
    }));
  const chosen = answer?.kind === "choice" ? answer : undefined;
  const chosenLabel =
    chosen?.choice !== undefined
      ? (options.find((option) => option.id === chosen.choice)?.label ??
        chosen.choice)
      : undefined;
  const summary = str(args.summary);
  return (
    <GalleryFrame title={title}>
      {summary ? <BotMarkdown text={summary} /> : null}
      <View className={cn("gap-2", summary && "mt-3")}>
        {byPosition(options).map(({ item, key }) => (
          <Offered
            key={key}
            label={item.label}
            description={item.description}
            picked={chosen?.choice !== undefined && item.id === chosen.choice}
          />
        ))}
      </View>
      <Outcome
        asked={asked}
        said={
          chosenLabel !== undefined
            ? `Answered: ${chosenLabel}.`
            : chosen?.answer
              ? `Answered: ${chosen.answer}`
              : undefined
        }
      />
    </GalleryFrame>
  );
}

export function FormCard({ args, arriving, answer, asked }: DecisionArgs) {
  const title = str(args.title);
  if (arriving && !title)
    return (
      <Preparing
        title="Preparing your form…"
        what="The Bot is putting the questions together."
      />
    );
  const fields = list(args.fields)
    .map(record)
    .map((field) => ({
      id: str(field.id) ?? "",
      label: str(field.label) ?? str(field.id) ?? "",
      required: field.required === true,
      help: str(field.help),
      options: list(field.options).filter(
        (option): option is string => typeof option === "string",
      ),
    }));
  const values = answer?.kind === "form" ? answer.values : undefined;
  const description = str(args.description);
  return (
    <GalleryFrame title={title} caption={description}>
      <View className="gap-2.5">
        {byPosition(fields).map(({ item, key }) => {
          const given = values?.[item.id];
          return (
            <View key={key} className="gap-0.5">
              <Text className="font-medium text-sm leading-5">
                {item.label}
                {item.required ? (
                  <Text tone="muted" className="font-normal text-sm">
                    {" "}
                    (required)
                  </Text>
                ) : null}
              </Text>
              {values ? (
                <Text selectable className="text-sm leading-5">
                  {given === undefined || given === "" ? "–" : String(given)}
                </Text>
              ) : item.options.length ? (
                <Text tone="muted" className="text-sm leading-5">
                  {item.options.join(", ")}
                </Text>
              ) : item.help ? (
                <Text variant="caption" tone="muted">
                  {item.help}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
      <Outcome
        asked={asked}
        said={values ? "Answered with what's above." : undefined}
      />
    </GalleryFrame>
  );
}
