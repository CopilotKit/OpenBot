import { Redirect, Stack } from "expo-router";
import { Button } from "heroui-native/button";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useCallback, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { everyPage, ME, type Memory, ORGANIZATION_ID } from "../src/api";
import {
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
} from "../src/api/generated/memory/memory";
import type { UpdateMemoryRequest } from "../src/api/generated/model";
import { authClient } from "../src/auth";
import {
  EmptyState,
  Notice,
  Rows,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { headerActions } from "../src/header";
import { IconBrain, IconPlus } from "../src/icons";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";

/**
 * Where a memory came from, said once: "You wrote this", "Learned by Inbox Zero, from Gmail",
 * "Imported from Notion: Company overview". `provenance` is the source in words ("You" for the
 * person's own), so the person's own line doesn't repeat it.
 */
function origin(memory: Memory) {
  const from = memory.provenance?.trim();
  switch (memory.formedBy) {
    case "person":
      return "You wrote this";
    case "bot":
      return from ? `Learned by ${from}` : "A Bot learned this";
    case "import":
      return from ? `Imported from ${from}` : "Imported";
    case "intelligence":
      return "Kept in the backend";
    default:
      return from || "Remembered";
  }
}

/**
 * What your Bots remember about you: read, add, edit, switch off and delete. The memories are one
 * card of rows, each its words, where it came from, and a switch for whether the Bots use it. A new
 * one is the + in the header; tapping one edits it, and deleting is there too. Every write carries
 * an Idempotency-Key, which the API client's mutator adds.
 */
export default function MemoryScreen() {
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [adding, setAdding] = useState(false);
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
  const add = () => {
    setEditing(undefined);
    setAdding(true);
  };
  const remove = (memory: Memory) =>
    Alert.alert("Delete this memory?", memory.content, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void action
            .run(memory.id, async () => {
              await deleteMemory(ORGANIZATION_ID, ME, memory.id);
              await memories.refresh();
            })
            .then((deleted) => {
              if (deleted) setEditing(undefined);
            });
        },
      },
    ]);

  const list = memories.data?.memories;
  return (
    <ScrollScreen
      refreshing={memories.pending}
      onRefresh={() => void memories.refresh()}
    >
      <Stack.Screen
        options={headerActions([
          { label: "Add a memory", sf: "plus", icon: IconPlus, onPress: add },
        ])}
      />
      <Notice message={action.error || memories.error || undefined} />
      {adding ? (
        <Section title="New memory">
          <Editor
            label="New memory"
            placeholder="Something your Bots should remember"
            value={draft}
            onChange={setDraft}
            busy={Boolean(action.busy)}
            saveLabel={action.busy === "add" ? "Remembering…" : "Remember"}
            onCancel={() => {
              setAdding(false);
              setDraft("");
            }}
            onSave={() => {
              void action
                .run("add", async () => {
                  await createMemory(ORGANIZATION_ID, ME, {
                    content: draft.trim(),
                  });
                  await memories.refresh();
                })
                .then((added) => {
                  if (!added) return;
                  setDraft("");
                  setAdding(false);
                });
            }}
          />
        </Section>
      ) : null}
      {list?.length === 0 && !adding ? (
        <EmptyState
          icon={IconBrain}
          title="Nothing remembered yet"
          description="What you add here, and what your Bots learn about you, shows up here."
          action={
            <Button size="sm" variant="secondary" onPress={add}>
              Add a memory
            </Button>
          }
        />
      ) : null}
      {list?.length ? (
        <View className="gap-2">
          <Rows iconless>
            {list.map((memory) =>
              editing?.id === memory.id ? (
                <View key={memory.id} className="px-3 py-3">
                  <Editor
                    label="Edit memory"
                    value={editing.content}
                    onChange={(content) =>
                      setEditing({ id: memory.id, content })
                    }
                    busy={Boolean(action.busy)}
                    saveLabel="Save"
                    onCancel={() => setEditing(undefined)}
                    onSave={() => {
                      void change(memory.id, {
                        content: editing.content.trim(),
                      }).then((saved) => {
                        if (saved) setEditing(undefined);
                      });
                    }}
                    onDelete={() => remove(memory)}
                  />
                </View>
              ) : (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  busy={Boolean(action.busy)}
                  onEdit={() => {
                    setAdding(false);
                    setEditing({ id: memory.id, content: memory.content });
                  }}
                  onUse={(enabled) => void change(memory.id, { enabled })}
                  onConfirm={() =>
                    void change(memory.id, { reviewState: "confirmed" })
                  }
                />
              ),
            )}
          </Rows>
          <Text variant="caption" tone="muted" className="px-1 leading-4">
            Your Bots use these facts when they work for you. Switch one off to
            stop using it without deleting it.
          </Text>
        </View>
      ) : null}
    </ScrollScreen>
  );
}

/**
 * One memory as a row: its words, where it came from, and the switch for whether the Bots use it.
 * One a Bot formed that the person hasn't looked at says so, in the color of what waits on them,
 * with Confirm beside it. Tapping the words edits it.
 */
function MemoryRow({
  memory,
  busy,
  onEdit,
  onUse,
  onConfirm,
}: {
  memory: Memory;
  busy: boolean;
  onEdit: () => void;
  onUse: (enabled: boolean) => void;
  onConfirm: () => void;
}) {
  const unreviewed = memory.reviewState === "unreviewed";
  return (
    <View className="flex-row items-start gap-3 px-3 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={memory.content}
        accessibilityHint="Edit or delete this memory"
        disabled={busy}
        onPress={onEdit}
        className="flex-1 gap-1 active:opacity-60"
      >
        <Text tone={memory.enabled ? "default" : "muted"}>
          {memory.content}
        </Text>
        <Text variant="caption" tone="muted">
          {origin(memory)}
        </Text>
        {unreviewed ? (
          <View className="mt-1.5 flex-row items-center gap-3">
            <Text variant="caption" tone="warning" className="flex-1">
              Not reviewed. Your Bots use it once you confirm it.
            </Text>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={onConfirm}
            >
              Confirm
            </Button>
          </View>
        ) : null}
      </Pressable>
      <Toggle
        label="Use this memory"
        value={memory.enabled}
        disabled={busy}
        onValueChange={onUse}
      />
    </View>
  );
}

/**
 * A memory being written: the field, then Cancel and the button that saves it, and Delete at the
 * start when it is one that exists. Delete is quiet text, and asks before it deletes.
 */
function Editor({
  label,
  placeholder,
  value,
  onChange,
  busy,
  saveLabel,
  onCancel,
  onSave,
  onDelete,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  return (
    <View className="gap-3">
      <TextField>
        <TextArea
          accessibilityLabel={label}
          placeholder={placeholder}
          value={value}
          onChangeText={onChange}
          maxLength={6000}
          autoFocus
        />
      </TextField>
      <View className="flex-row items-center gap-2">
        {onDelete ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onPress={onDelete}
          >
            <Button.Label className="text-danger">Delete</Button.Label>
          </Button>
        ) : null}
        <View className="flex-1" />
        <Button size="sm" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
        <Button size="sm" isDisabled={busy || !value.trim()} onPress={onSave}>
          {saveLabel}
        </Button>
      </View>
    </View>
  );
}
