import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useCallback, useState } from "react";
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
  Card,
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
 * answers the server takes, and the questions they asked. A notification opens it at one of them,
 * which is ringed.
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
  return (
    <ScrollScreen
      className="gap-3"
      refreshing={inbox.pending}
      onRefresh={() => void inbox.refresh()}
    >
      <Notice message={error || inbox.error || undefined} />
      {pending?.map((request) => {
        // In the web card's words: what the Bot wants to do, why it asks, and what would change.
        const change = approvalChange(request.action.target);
        const details = change ? [] : approvalDetails(request.action.args);
        return (
          <Card
            key={request.id}
            highlighted={request.id === requestId}
            className="gap-3"
          >
            <Text variant="label" className="font-semibold">
              {approvalTitle(request.action, botName(request.action.botId))}
            </Text>
            {request.action.policy?.reason ? (
              <Text tone="muted" className="-mt-1">
                {request.action.policy.reason}
              </Text>
            ) : null}
            {change ? <ChangeRows change={change} /> : null}
            {details.length > 0 ? (
              <View className="gap-1">
                {details.map((line) => (
                  <Text key={line.label}>
                    <Text tone="muted">{line.label}: </Text>
                    {line.value}
                  </Text>
                ))}
              </View>
            ) : null}
            {/* Only the answers the server takes: no "Always allow" where it always asks. */}
            <View className="flex-row flex-wrap gap-2">
              {approvalChoices(request.action).map((choice, index) => (
                <Button
                  key={choice}
                  size="sm"
                  variant={index === 0 ? "primary" : "outline"}
                  isDisabled={Boolean(busy)}
                  onPress={() => {
                    void decide(request.id, choice);
                  }}
                >
                  {DECISION_LABELS[choice]}
                </Button>
              ))}
            </View>
          </Card>
        );
      })}
      {questions.map((question) => (
        <Card
          key={question.id}
          highlighted={question.id === requestId}
          className="gap-3"
        >
          <Text variant="caption" tone="muted">
            {botName(question.botId) ?? "A Bot"} asks
          </Text>
          <Text variant="label" className="-mt-2 font-semibold">
            {question.question}
          </Text>
          {question.why ? <Text tone="muted">{question.why}</Text> : null}
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
            className="self-start"
            isDisabled={Boolean(busy) || !answers[question.id]?.trim()}
            onPress={() => {
              void respond(question.id);
            }}
          >
            {busy === question.id ? "Sending…" : "Send answer"}
          </Button>
        </Card>
      ))}
      {inbox.data && !pending?.length && !questions.length ? (
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
