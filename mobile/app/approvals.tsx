import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import {
  Button,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
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
import { colors } from "../src/ui";
import { useLoad } from "../src/use-load";
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
  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={inbox.pending}
          onRefresh={() => {
            void inbox.refresh();
          }}
        />
      }
    >
      <Text style={{ fontSize: 24, fontWeight: "600" }}>
        Questions and approvals
      </Text>
      {(error || inbox.error) && (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error || inbox.error}
        </Text>
      )}
      {inbox.data?.requests
        .filter((request) => request.status === "pending")
        .map((request) => {
          // In the web card's words: what the Bot wants to do, why it asks, and what would change.
          const change = approvalChange(request.action.target);
          const details = change ? [] : approvalDetails(request.action.args);
          return (
            <View
              key={request.id}
              style={{
                gap: 10,
                borderWidth: request.id === requestId ? 2 : 1,
                borderColor: "#9ca3af",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <Text style={{ fontWeight: "600" }}>
                {approvalTitle(request.action, botName(request.action.botId))}
              </Text>
              {request.action.policy?.reason ? (
                <Text style={{ color: colors.muted }}>
                  {request.action.policy.reason}
                </Text>
              ) : null}
              {change ? <ChangeRows change={change} /> : null}
              {details.map((line) => (
                <Text key={line.label}>
                  <Text style={{ color: colors.muted }}>{line.label}: </Text>
                  {line.value}
                </Text>
              ))}
              {/* Only the answers the server takes: no "Always allow" where it always asks. */}
              {approvalChoices(request.action).map((choice) => (
                <Button
                  key={choice}
                  disabled={Boolean(busy)}
                  title={DECISION_LABELS[choice]}
                  onPress={() => {
                    void decide(request.id, choice);
                  }}
                />
              ))}
            </View>
          );
        })}
      {inbox.data?.questions?.map((question) => (
        <View
          key={question.id}
          style={{
            gap: 10,
            borderWidth: question.id === requestId ? 2 : 1,
            borderColor: "#9ca3af",
            borderRadius: 8,
            padding: 14,
          }}
        >
          <Text style={{ fontWeight: "600" }}>{question.botId}</Text>
          <Text>{question.question}</Text>
          {question.why && <Text>{question.why}</Text>}
          <TextInput
            accessibilityLabel="Your answer"
            multiline
            placeholder="Your answer"
            value={answers[question.id] ?? ""}
            onChangeText={(answer) =>
              setAnswers((current) => ({ ...current, [question.id]: answer }))
            }
            style={{ borderWidth: 1, padding: 10 }}
          />
          <Button
            disabled={Boolean(busy) || !answers[question.id]?.trim()}
            title="Send answer"
            onPress={() => {
              void respond(question.id);
            }}
          />
        </View>
      ))}
      {inbox.data?.requests.every((request) => request.status !== "pending") &&
        !inbox.data.questions?.length && <Text>No pending requests.</Text>}
    </ScrollView>
  );
}

/**
 * A settings change while it waits: its summary, each setting before over after (stacked, so a long
 * value wraps), and who it reaches. The after is what would be, not yet what is.
 */
function ChangeRows({ change }: { change: ApprovalChange }) {
  return (
    <View style={{ gap: 10 }}>
      <Text>{change.summary}</Text>
      {change.rows.length > 0 ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
          }}
        >
          {change.rows.map((row, index) => (
            <View
              key={row.label}
              style={{
                gap: 4,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: colors.border,
              }}
            >
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                {row.label}
              </Text>
              <Text
                style={{
                  color: colors.muted,
                  textDecorationLine:
                    row.before === null ? "none" : "line-through",
                }}
              >
                {row.before ?? "Not set"}
              </Text>
              <Text accessible={false} style={{ color: colors.muted }}>
                ↓
              </Text>
              <Text style={{ fontWeight: "600" }}>
                {row.after ?? "Not set"}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {change.affected ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>
            {change.affected.summary}
          </Text>
          {change.affected.people.length > 0 ? (
            <Text style={{ fontSize: 13 }}>
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
