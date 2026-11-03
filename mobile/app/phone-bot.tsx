import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  Button,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  askNeedle,
  type NeedleCall,
  needleAvailable,
} from "../modules/needle/src";
import {
  describe,
  doJob,
  load,
  type Note,
  phoneFacts,
  phoneTools,
  removeNote,
  removeWaiting,
  sendWaiting,
} from "../src/phone-bot";
import { card, colors, heading, input, muted, subheading } from "../src/ui";
import { VoiceTypingButton } from "../src/voice-typing";

/** Above this Needle's pick is done straight away; below it, the phone asks first. */
const SURE = 0.7;

type Said = { id: number; you: string; bot: string; notes?: Note[] };

/**
 * The Phone Bot: quick jobs done on the phone itself, with no PC and no signal.
 *
 * Needle picks the job and fills in its details; nothing leaves the phone except a message for a PC
 * Bot, which waits here until the PC can be reached. When Needle isn't sure, it says what it thinks
 * you meant and waits for a yes, the same "ask me" as the rest of OpenBot.
 */
export default function PhoneBot() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said[]>([]);
  const [unsure, setUnsure] = useState<{
    you: string;
    calls: NeedleCall[];
  } | null>(null);
  const [saved, setSaved] = useState(load);
  const available = needleAvailable();

  const refresh = useCallback(() => setSaved(load()), []);
  useFocusEffect(
    useCallback(() => {
      refresh();
      void sendWaiting().then(refresh);
    }, [refresh]),
  );

  function answer(you: string, bot: string, notes?: Note[]) {
    setSaid((now) =>
      [{ id: Date.now(), you, bot, notes }, ...now].slice(0, 20),
    );
  }

  async function run(you: string, calls: NeedleCall[]) {
    const lines: string[] = [];
    let notes: Note[] | undefined;
    for (const call of calls) {
      const done = await doJob(call);
      lines.push(done.said);
      if (done.notes) notes = done.notes;
      if (done.open) router.push(done.open as never);
    }
    answer(you, lines.join(" "), notes);
    refresh();
  }

  async function ask() {
    const you = text.trim();
    if (!you || busy) return;
    setBusy(true);
    setUnsure(null);
    try {
      const reply = await askNeedle(you, phoneTools(saved.bots), phoneFacts());
      setText("");
      if (reply.calls.length && (reply.confidence ?? 1) >= SURE)
        await run(you, reply.calls);
      else if (reply.calls.length || reply.unsure.length)
        setUnsure({
          you,
          calls: reply.calls.length ? reply.calls : reply.unsure,
        });
      else
        answer(
          you,
          "That's not one I can do on the phone. I can set reminders, save and find notes, open parts of the app, and pass messages to your Bots.",
        );
    } catch (failure) {
      answer(
        you,
        failure instanceof Error ? failure.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={heading}>Phone Bot</Text>
      <Text style={muted}>
        Quick jobs done right on your phone, with no PC and no signal:
        reminders, notes, opening parts of the app, and messages that wait for
        your Bots.
      </Text>

      {!available ? (
        <View style={card}>
          <Text style={{ fontWeight: "600" }}>Needle isn't in this build</Text>
          <Text style={muted}>
            The Phone Bot needs Needle's two files added before the app is
            built. See modules/needle/README.md.
          </Text>
        </View>
      ) : null}

      <TextInput
        accessibilityLabel="Ask the Phone Bot"
        editable={available && !busy}
        multiline
        onChangeText={setText}
        onSubmitEditing={() => void ask()}
        placeholder={'Try "remind me to call mum at 5pm"'}
        style={[input, { minHeight: 56 }]}
        value={text}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <VoiceTypingButton
          disabled={!available || busy}
          onText={setText}
          text={text}
        />
        <Button
          disabled={!available || busy || !text.trim()}
          onPress={() => void ask()}
          title={busy ? "Working…" : "Go"}
        />
      </View>

      {unsure ? (
        <View style={card}>
          <Text style={{ fontWeight: "600" }}>Did you mean…</Text>
          {unsure.calls.map((call, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one answer's calls never reorder
            <Text key={index}>• {describe(call)}</Text>
          ))}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button
              onPress={() => {
                const { you, calls } = unsure;
                setUnsure(null);
                void run(you, calls);
              }}
              title="Yes, do it"
            />
            <Button
              color={colors.muted}
              onPress={() => setUnsure(null)}
              title="No"
            />
          </View>
        </View>
      ) : null}

      {said.map((entry) => (
        <View key={entry.id} style={{ gap: 6 }}>
          <Text style={muted}>You: {entry.you}</Text>
          <Text>{entry.bot}</Text>
          {entry.notes?.map((note) => (
            <View key={note.id} style={[card, { padding: 10 }]}>
              <Text>{note.text}</Text>
              <Text style={[muted, { fontSize: 12 }]}>
                {new Date(note.at).toLocaleString()}
              </Text>
            </View>
          ))}
        </View>
      ))}

      {saved.outbox.length ? (
        <View style={{ gap: 8 }}>
          <Text style={subheading}>Waiting to send</Text>
          {saved.outbox.map((entry) => (
            <View key={entry.id} style={card}>
              <Text style={{ fontWeight: "600" }}>To {entry.bot}</Text>
              <Text>{entry.message}</Text>
              {entry.problem ? (
                <Text style={{ color: colors.warning }}>{entry.problem}</Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  removeWaiting(entry.id);
                  refresh();
                }}
              >
                <Text style={{ color: colors.error }}>Don't send</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <Text style={subheading}>Notes on this phone</Text>
        {saved.notes.length === 0 ? (
          <Text style={muted}>None yet. Try "note: buy milk".</Text>
        ) : null}
        {saved.notes.slice(0, 20).map((note) => (
          <View key={note.id} style={card}>
            <Text>{note.text}</Text>
            <View
              style={{ flexDirection: "row", justifyContent: "space-between" }}
            >
              <Text style={[muted, { fontSize: 12 }]}>
                {new Date(note.at).toLocaleString()}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  removeNote(note.id);
                  refresh();
                }}
              >
                <Text style={{ color: colors.error }}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
