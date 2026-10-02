import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Button, Switch, Text, TextInput, View } from "react-native";
import { api, type Memory } from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  heading,
  input,
  muted,
  Problem,
  Screen,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

const ORIGIN: Record<Memory["formedBy"], string> = {
  person: "You wrote this",
  import: "Imported",
  bot: "A Bot learned this",
};

/** What your Bots remember about you: read, add, edit, switch off and delete. */
export default function MemoryScreen() {
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string }>();
  const load = useCallback(
    () => api<{ memories: Memory[] }>("/api/memory"),
    [],
  );
  const memories = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;

  const change = (id: string, body: Record<string, unknown>) =>
    action.run(id, async () => {
      await api(`/api/memory/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
      });
      await memories.refresh();
    });

  return (
    <Screen
      refreshing={memories.pending}
      onRefresh={() => void memories.refresh()}
    >
      <Text style={heading}>Memory</Text>
      <Text style={muted}>
        Your Bots use these facts when they work for you. Switch one off to stop
        using it without deleting it.
      </Text>
      <Problem message={action.error || memories.error} />
      <View style={card}>
        <TextInput
          accessibilityLabel="New memory"
          multiline
          placeholder="Something your Bots should remember"
          value={draft}
          onChangeText={setDraft}
          maxLength={6000}
          style={input}
        />
        <Button
          title="Remember this"
          disabled={Boolean(action.busy) || !draft.trim()}
          onPress={() => {
            void action.run("add", async () => {
              await api("/api/memory", {
                method: "POST",
                body: { content: draft.trim() },
              });
              setDraft("");
              await memories.refresh();
            });
          }}
        />
      </View>
      {memories.data?.memories.length === 0 && (
        <Text style={muted}>Nothing remembered yet.</Text>
      )}
      {memories.data?.memories.map((memory) => (
        <View key={memory.id} style={card}>
          {editing?.id === memory.id ? (
            <>
              <TextInput
                accessibilityLabel="Edit memory"
                multiline
                value={editing.content}
                onChangeText={(content) =>
                  setEditing({ id: memory.id, content })
                }
                maxLength={6000}
                style={input}
              />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button
                  title="Save"
                  disabled={Boolean(action.busy) || !editing.content.trim()}
                  onPress={() => {
                    void change(memory.id, {
                      content: editing.content.trim(),
                    }).then((saved) => {
                      if (saved) setEditing(undefined);
                    });
                  }}
                />
                <Button title="Cancel" onPress={() => setEditing(undefined)} />
              </View>
            </>
          ) : (
            <Text style={memory.enabled ? undefined : muted}>
              {memory.content}
            </Text>
          )}
          <Text style={muted}>
            {ORIGIN[memory.formedBy]} · {memory.provenance}
            {memory.reviewState === "unreviewed" ? " · not reviewed" : ""}
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Switch
                accessibilityLabel="Use this memory"
                value={memory.enabled}
                disabled={Boolean(action.busy)}
                onValueChange={(enabled) => {
                  void change(memory.id, { enabled });
                }}
              />
              <Text>{memory.enabled ? "In use" : "Off"}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 4 }}>
              {memory.reviewState === "unreviewed" && (
                <Button
                  title="Confirm"
                  disabled={Boolean(action.busy)}
                  onPress={() => {
                    void change(memory.id, { reviewState: "confirmed" });
                  }}
                />
              )}
              <Button
                title="Edit"
                disabled={Boolean(action.busy)}
                onPress={() =>
                  setEditing({ id: memory.id, content: memory.content })
                }
              />
              <Button
                title="Delete"
                disabled={Boolean(action.busy)}
                onPress={() =>
                  Alert.alert("Delete this memory?", memory.content, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => {
                        void action.run(memory.id, async () => {
                          await api(
                            `/api/memory/${encodeURIComponent(memory.id)}`,
                            { method: "DELETE" },
                          );
                          await memories.refresh();
                        });
                      },
                    },
                  ])
                }
              />
            </View>
          </View>
        </View>
      ))}
    </Screen>
  );
}
