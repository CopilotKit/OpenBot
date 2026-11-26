import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { type ReactNode, useCallback, useState } from "react";
import { View } from "react-native";
import { everyBot, loadApprovalInbox, ME, ORGANIZATION_ID } from "../src/api";
import {
  decideApproval,
  respondToQuestion,
} from "../src/api/generated/approvals/approvals";
import {
  type ApprovalChange,
  approvalChange,
  approvalChoices,
  approvalDetails,
  approvalTitle,
  DECISION_LABELS,
  type PhoneDecision,
} from "../src/approval-words";
import { authClient } from "../src/auth";
import {
  BotOrb,
  cn,
  EmptyState,
  Notice,
  ScrollScreen,
  Text,
} from "../src/components";
import { IconChecks } from "../src/icons";
import { useLoad } from "../src/use-load";

/**
 * The approval inbox: what the person's Bots want to do and asked first about, each with only the
 * answers the server takes, and the questions they asked. Each is a row like a chat's, under its
 * Bot's orb, with hairlines between them. A notification opens it at one of them, which is ringed.
 */
export default function ApprovalsScreen() {
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const load = useCallback(() => loadApprovalInbox(), []);
  const inbox = useLoad(load, Boolean(session));
  // Each Bot by its name: the list carries only its id.
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  const botName = (id: string) => bots.data?.find((bot) => bot.id === id)?.name;
  const botSeed = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.avatarSeed || id;
  if (!session && !isPending) return <Redirect href="/" />;
  async function decide(id: string, decision: PhoneDecision) {
    setBusy(id);
    setError("");
    try {
      await decideApproval(ORGANIZATION_ID, ME, id, { decision });
      await inbox.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save your decision.",
      );
    } finally {
      setBusy("");
    }
  }
  async function respond(id: string) {
    setBusy(id);
    setError("");
    try {
      await respondToQuestion(ORGANIZATION_ID, ME, id, {
        response: answers[id] ?? "",
      });
      await inbox.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not send your answer.",
      );
    } finally {
      setBusy("");
    }
  }
  const pending = inbox.data?.requests.filter(
    (request) => request.status === "pending",
  );
  const questions = inbox.data?.questions ?? [];
  const empty = inbox.data && !pending?.length && !questions.length;
  const problem = error || inbox.error || undefined;
  return (
    // Rows run the width of the screen, as the Chats and Bots lists do.
    <ScrollScreen
      className="gap-0 px-0 pt-2"
      refreshing={inbox.pending}
      onRefresh={() => void inbox.refresh()}
    >
      {problem ? (
        <View className="px-4 pb-2">
          <Notice message={problem} />
        </View>
      ) : null}
      {pending?.map((request, index) => {
        // In the web card's words: what the Bot wants to do, why it asks, and what would change.
        const change = approvalChange(request.action.target);
        const details = change ? [] : approvalDetails(request.action.args);
        const choices = approvalChoices(request.action);
        // Allow once and Deny side by side; a standing rule, when the server takes one, quieter under them.
        const main = choices.filter((choice) => choice !== "allow_always");
        const standing = choices.filter((choice) => choice === "allow_always");
        const name = botName(request.action.botId);
        return (
          <Item
            key={request.id}
            first={index === 0}
            highlighted={request.id === requestId}
            seed={botSeed(request.action.botId)}
            name={name ?? "Bot"}
          >
            <Text variant="label">{approvalTitle(request.action, name)}</Text>
            {request.action.policy?.reason ? (
              <Text tone="muted" className="text-sm leading-5">
                {request.action.policy.reason}
              </Text>
            ) : null}
            {change ? <ChangeRows change={change} /> : null}
            {details.length > 0 ? (
              <View className="mt-1 gap-1.5">
                {details.map((line) => (
                  <View key={line.label} className="flex-row gap-3">
                    <Text tone="muted" className="w-20 text-sm leading-5">
                      {line.label}
                    </Text>
                    <Text className="flex-1 text-sm leading-5">
                      {line.value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {/* Only the answers the server takes: no "Always allow" where it always asks. */}
            <View className="mt-2 flex-row gap-2">
              {main.map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  className="flex-1"
                  variant={choice === "deny" ? "secondary" : "primary"}
                  isDisabled={Boolean(busy)}
                  onPress={() => {
                    void decide(request.id, choice);
                  }}
                >
                  {DECISION_LABELS[choice]}
                </Button>
              ))}
            </View>
            {standing.map((choice) => (
              <Button
                key={choice}
                size="sm"
                variant="ghost"
                isDisabled={Boolean(busy)}
                onPress={() => {
                  void decide(request.id, choice);
                }}
              >
                {DECISION_LABELS[choice]}
              </Button>
            ))}
          </Item>
        );
      })}
      {questions.map((question, index) => (
        <Item
          key={question.id}
          first={!pending?.length && index === 0}
          highlighted={question.id === requestId}
          seed={botSeed(question.botId)}
          name={botName(question.botId) ?? "Bot"}
        >
          <Text variant="caption" tone="muted">
            {botName(question.botId) ?? "A Bot"} asks
          </Text>
          <Text variant="label">{question.question}</Text>
          {question.why ? (
            <Text tone="muted" className="text-sm leading-5">
              {question.why}
            </Text>
          ) : null}
          <View className="mt-2 gap-2">
            <TextField>
              <TextArea
                accessibilityLabel="Your answer"
                placeholder="Your answer"
                value={answers[question.id] ?? ""}
                onChangeText={(answer) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: answer,
                  }))
                }
              />
            </TextField>
            <Button
              size="sm"
              className="self-end"
              isDisabled={Boolean(busy) || !answers[question.id]?.trim()}
              onPress={() => {
                void respond(question.id);
              }}
            >
              {busy === question.id ? "Sending…" : "Send answer"}
            </Button>
          </View>
        </Item>
      ))}
      {empty ? (
        <EmptyState
          icon={IconChecks}
          title="Nothing to approve"
          description="When a Bot asks before it acts, or asks you a question, it shows up here."
        />
      ) : null}
    </ScrollScreen>
  );
}

/**
 * One approval or question, as a chat's row: the Bot's orb, and what it asks beside it. A hairline
 * parts it from the one above, from the text's edge as the platform's lists draw it. The one a
 * notification opened is ringed in the scheme's `ring`.
 */
function Item({
  seed,
  name,
  first,
  highlighted,
  children,
}: {
  seed: string;
  name: string;
  first: boolean;
  highlighted: boolean;
  children: ReactNode;
}) {
  return (
    <View>
      {first ? null : <View className="ml-17 h-px bg-border" />}
      <View
        className={cn(
          "flex-row gap-3 px-4 py-4",
          highlighted && "mx-2 rounded-lg border-2 border-focus px-2",
        )}
      >
        <BotOrb seed={seed} name={name} size={40} />
        <View className="flex-1 gap-1">{children}</View>
      </View>
    </View>
  );
}

/**
 * A settings change while it waits: its summary, each setting before over after (stacked, so a long
 * value wraps), and who it reaches. The after is what would be, not yet what is.
 */
function ChangeRows({ change }: { change: ApprovalChange }) {
  return (
    <View className="gap-2">
      <Text>{change.summary}</Text>
      {change.rows.length > 0 ? (
        <View className="overflow-hidden rounded-md border border-border">
          {change.rows.map((row, index) => (
            <View
              key={row.label}
              className={cn(
                "gap-1 px-3 py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <Text variant="caption" tone="muted">
                {row.label}
              </Text>
              <Text
                tone="muted"
                className={cn(row.before !== null && "line-through")}
              >
                {row.before ?? "Not set"}
              </Text>
              <Text accessible={false} tone="muted">
                ↓
              </Text>
              <Text className="font-semibold">{row.after ?? "Not set"}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {change.affected ? (
        <View className="gap-0.5">
          <Text variant="caption" tone="muted">
            {change.affected.summary}
          </Text>
          {change.affected.people.length > 0 ? (
            <Text className="text-sm">
              {change.affected.people.join(", ")}
              {change.affected.more > 0
                ? ` and ${change.affected.more} more`
                : ""}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
