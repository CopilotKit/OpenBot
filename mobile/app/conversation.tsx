import * as Crypto from "expo-crypto";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Conversation, type TranscriptMessage } from "../src/api";
import { authClient } from "../src/auth";
import { useLoad } from "../src/use-load";
export default function ConversationScreen() {
  const {
    channelId,
    agentId: requestedAgentId,
    draft,
  } = useLocalSearchParams<{
    channelId: string;
    agentId?: string;
    draft?: string;
  }>();
  const { data: session, isPending } = authClient.useSession();
  const [agentId, setAgentId] = useState("");
  // A Bot profile's "Add routine" arrives with its sentence started for the person to finish.
  const [text, setText] = useState(draft ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  const loadChannels = useCallback(
    () =>
      api<{ channel: Conversation }>(
        `/api/channels/${encodeURIComponent(channelId ?? "")}`,
      ),
    [channelId, session?.user.id],
  );
  const channels = useLoad(loadChannels, Boolean(session));
  const conversation = channels.data?.channel;
  useEffect(() => {
    if (conversation && !agentId)
      setAgentId(
        requestedAgentId && conversation.agentIds.includes(requestedAgentId)
          ? requestedAgentId
          : (conversation.agentIds[0] ?? ""),
      );
  }, [conversation, agentId, requestedAgentId]);
  const loadHistory = useCallback(
    () =>
      api<{ history: TranscriptMessage[] | { messages: TranscriptMessage[] } }>(
        `/api/delivery/conversations/${encodeURIComponent(channelId ?? "")}/history?agentId=${encodeURIComponent(agentId)}`,
      ),
    [channelId, agentId],
  );
  const history = useLoad(loadHistory, Boolean(session && agentId));
  if (!session && !isPending) return <Redirect href="/" />;
  const messages = Array.isArray(history.data?.history)
    ? history.data.history
    : history.data?.history.messages;
  async function send() {
    if (!text.trim() || !agentId || sending) return;
    setSending(true);
    setError("");
    const pendingText = text;
    const externalId = Crypto.randomUUID();
    try {
      await api(
        `/api/delivery/conversations/${encodeURIComponent(channelId)}/messages`,
        { method: "POST", body: { agentId, text: pendingText, externalId } },
      );
      setText("");
      await history.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not send your message.",
      );
    } finally {
      setSending(false);
    }
  }
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "600" }}>
        {conversation?.name ?? "Conversation"}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {conversation?.agentIds.map((id) => (
          <Button
            key={id}
            title={id === agentId ? `${id} ✓` : id}
            onPress={() => setAgentId(id)}
          />
        ))}
      </View>
      {(error || channels.error || history.error) && (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error || channels.error || history.error}
        </Text>
      )}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={history.pending}
            onRefresh={() => {
              void history.refresh();
            }}
          />
        }
        contentContainerStyle={{ gap: 12 }}
      >
        {messages?.map((message) => (
          <View
            key={message.id}
            style={{
              padding: 12,
              backgroundColor: message.role === "user" ? "#eff6ff" : "#f3f4f6",
              borderRadius: 8,
            }}
          >
            <Text style={{ fontWeight: "600" }}>
              {message.role === "user" ? "You" : agentId}
            </Text>
            <Text>
              {typeof message.content === "string"
                ? message.content
                : message.toolCalls?.length
                  ? "The Bot is using a tool."
                  : ""}
            </Text>
          </View>
        ))}
      </ScrollView>
      <TextInput
        accessibilityLabel="Message"
        multiline
        autoFocus={Boolean(draft)}
        value={text}
        onChangeText={setText}
        editable={conversation?.active && !sending}
        placeholder="Message this Bot"
        style={{
          borderWidth: 1,
          borderColor: "#9ca3af",
          borderRadius: 8,
          padding: 12,
          maxHeight: 140,
        }}
      />
      <Button
        title={sending ? "Sending…" : "Send"}
        disabled={!conversation?.active || !agentId || !text.trim() || sending}
        onPress={() => {
          void send();
        }}
      />
    </View>
  );
}
