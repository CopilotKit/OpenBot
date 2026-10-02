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
import { type ApprovalInbox, api } from "../src/api";
import { authClient } from "../src/auth";
import { useLoad } from "../src/use-load";
export default function ApprovalsScreen() {
  const { requestId } = useLocalSearchParams<{ requestId?: string }>();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const load = useCallback(() => api<ApprovalInbox>("/api/approvals"), []);
  const inbox = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  async function decide(
    id: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) {
    setBusy(id);
    setError("");
    try {
      await api(`/api/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body: { decision },
      });
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
      await api(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
        method: "POST",
        body: { response: answers[id] ?? "" },
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
        .map((request) => (
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
              {request.botId ?? request.action?.botId} asks to use{" "}
              {request.toolRef ?? request.action?.toolRef}
            </Text>
            <Text>
              {request.effect ?? request.action?.effect} ·{" "}
              {request.scope ?? request.action?.scope}
            </Text>
            <Text>
              {JSON.stringify(request.preview ?? request.action?.args, null, 2)}
            </Text>
            <Button
              disabled={Boolean(busy)}
              title="Allow once"
              onPress={() => {
                void decide(request.id, "allow_once");
              }}
            />
            <Button
              disabled={Boolean(busy)}
              title="Always allow this scope"
              onPress={() => {
                void decide(request.id, "allow_always");
              }}
            />
            <Button
              disabled={Boolean(busy)}
              title="Deny"
              onPress={() => {
                void decide(request.id, "deny");
              }}
            />
          </View>
        ))}
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
