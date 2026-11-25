import { Redirect } from "expo-router";
import { Button } from "heroui-native/button";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import { everyPage, ME, type Memory, ORGANIZATION_ID } from "../../../src/api";
import {
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
} from "../../../src/api/generated/memory/memory";
import type { UpdateMemoryRequest } from "../../../src/api/generated/model";
import { authClient } from "../../../src/auth";
import {
  cn,
  EmptyState,
  Notice,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../../../src/components";
import { IconBrain } from "../../../src/icons";
import { useAction } from "../../../src/ui";
import { useLoad } from "../../../src/use-load";

const ORIGIN: Record<Memory["formedBy"], string> = {
  person: "You wrote this",
  import: "Imported",
  bot: "A Bot learned this",
  intelligence: "Kept in the backend",
};

/**
 * What your Bots remember about you: read, add, edit, switch off and delete. Each memory is a card
 * with its words, where it came from, a switch for whether the Bots use it, and its actions. Every
 * write carries an Idempotency-Key, which the API client's mutator adds.
 */
export default function MemoryScreen() {
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string }>();
  const load = useCallback(
    async () => ({
      memories: await everyPage(
        (page) => listMemories(ORGANIZATION_ID, ME, page),
        (page) => page.memories,
      ),
    }),
    [],
  );
  const memories = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;

  const change = (id: string, body: UpdateMemoryRequest) =>
    action.run(id, async () => {
      await updateMemory(ORGANIZATION_ID, ME, id, body);
      await memories.refresh();
    });

  const list = memories.data?.memories;
  return (
    <ScrollScreen
      refreshing={memories.pending}
      onRefresh={() => void memories.refresh()}
    >
      <Text tone="muted">
        Your Bots use these facts when they work for you. Switch one off to stop
        using it without deleting it.
      </Text>
      <Notice message={action.error || memories.error || undefined} />
      <View className="gap-3">
        <TextField>
          <TextArea
            accessibilityLabel="New memory"
            placeholder="Something your Bots should remember"
            value={draft}
            onChangeText={setDraft}
            maxLength={6000}
          />
        </TextField>
        <Button
          isDisabled={Boolean(action.busy) || !draft.trim()}
          onPress={() => {
            void action.run("add", async () => {
              await createMemory(ORGANIZATION_ID, ME, {
                content: draft.trim(),
              });
              setDraft("");
              await memories.refresh();
            });
          }}
        >
          {action.busy === "add" ? "Remembering…" : "Remember this"}
        </Button>
      </View>
      {list?.length === 0 ? (
        <EmptyState
          icon={IconBrain}
          title="Nothing remembered yet"
          description="What you add here, and what your Bots learn about you, shows up here."
        />
      ) : null}
      {list?.length ? (
        <Section title="Remembered">
          <View className="gap-3">
            {list.map((memory) => (
              <View
                key={memory.id}
                className="gap-3 rounded-lg border border-border bg-surface p-4"
              >
                {editing?.id === memory.id ? (
                  <View className="gap-2">
                    <TextField>
                      <TextArea
                        accessibilityLabel="Edit memory"
                        value={editing.content}
                        onChangeText={(content) =>
                          setEditing({ id: memory.id, content })
                        }
                        maxLength={6000}
                        autoFocus
                      />
                    </TextField>
                    <View className="flex-row gap-2">
                      <Button
                        size="sm"
                        isDisabled={
                          Boolean(action.busy) || !editing.content.trim()
                        }
                        onPress={() => {
                          void change(memory.id, {
                            content: editing.content.trim(),
                          }).then((saved) => {
                            if (saved) setEditing(undefined);
                          });
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => setEditing(undefined)}
                      >
                        Cancel
                      </Button>
                    </View>
                  </View>
                ) : (
                  <Text
                    className={cn(!memory.enabled && "text-muted line-through")}
                  >
                    {memory.content}
                  </Text>
                )}
                <Text variant="caption" tone="muted">
                  {ORIGIN[memory.formedBy] ?? "Remembered"} ·{" "}
                  {memory.provenance}
                  {memory.reviewState === "unreviewed" ? " · Not reviewed" : ""}
                </Text>
                <View className="flex-row items-center justify-between gap-2 border-t border-border pt-3">
                  <View className="flex-row items-center gap-2">
                    <Toggle
                      label="Use this memory"
                      value={memory.enabled}
                      disabled={Boolean(action.busy)}
                      onValueChange={(enabled) => {
                        void change(memory.id, { enabled });
                      }}
                    />
                    <Text variant="caption" tone="muted">
                      {memory.enabled ? "In use" : "Off"}
                    </Text>
                  </View>
                  <View className="flex-row gap-1">
                    {memory.reviewState === "unreviewed" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={Boolean(action.busy)}
                        onPress={() => {
                          void change(memory.id, { reviewState: "confirmed" });
                        }}
                      >
                        Confirm
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={Boolean(action.busy)}
                      onPress={() =>
                        setEditing({ id: memory.id, content: memory.content })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-soft"
                      isDisabled={Boolean(action.busy)}
                      onPress={() =>
                        Alert.alert("Delete this memory?", memory.content, [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: () => {
                              void action.run(memory.id, async () => {
                                await deleteMemory(
                                  ORGANIZATION_ID,
                                  ME,
                                  memory.id,
                                );
                                await memories.refresh();
                              });
                            },
                          },
                        ])
                      }
                    >
                      Delete
                    </Button>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
    </ScrollScreen>
  );
}
