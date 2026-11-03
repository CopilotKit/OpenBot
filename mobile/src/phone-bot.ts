import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import type { NeedleCall, NeedleTool } from "../modules/needle/src";
import { api, type Bot, type Conversation } from "./api";

/**
 * The Phone Bot: what the phone can do on its own, with no PC and no signal.
 *
 * Needle (on the phone) reads the request and picks one of these jobs; this file does the job.
 * Everything here is kept on the phone in one small file. A message for a PC Bot waits in the
 * outbox and goes when the PC can be reached, so the phone works alone and catches up later.
 */

export type Note = { id: string; text: string; at: string };
export type Waiting = {
  id: string;
  bot: string;
  message: string;
  at: string;
  /** Why it hasn't gone yet, when a try failed for a reason other than no connection. */
  problem?: string;
};
type Saved = { notes: Note[]; outbox: Waiting[]; bots: string[] };

const FILE = new File(Paths.document, "phone-bot.json");
const EMPTY: Saved = { notes: [], outbox: [], bots: [] };

export function load(): Saved {
  try {
    if (!FILE.exists) return { ...EMPTY };
    const saved = JSON.parse(FILE.textSync()) as Partial<Saved>;
    return {
      notes: Array.isArray(saved.notes) ? saved.notes : [],
      outbox: Array.isArray(saved.outbox) ? saved.outbox : [],
      bots: Array.isArray(saved.bots) ? saved.bots : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function save(next: Saved) {
  if (!FILE.exists) FILE.create();
  FILE.write(JSON.stringify(next));
}

const id = () => Crypto.randomUUID();

/** The jobs Needle may pick, with the Bots' names the phone last saw so it can match them. */
export function phoneTools(bots: string[]): NeedleTool[] {
  return [
    {
      name: "remind_me_at",
      description: "Set a reminder on this phone for a date and time.",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", description: "What to be reminded of" },
          at: {
            type: "string",
            description: "When, as YYYY-MM-DD HH:MM in 24-hour time",
          },
        },
        required: ["what", "at"],
      },
    },
    {
      name: "remind_me_in",
      description: "Set a reminder on this phone a number of minutes from now.",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", description: "What to be reminded of" },
          minutes: {
            type: "integer",
            description: "How many minutes from now. An hour is 60",
          },
        },
        required: ["what", "minutes"],
      },
    },
    {
      name: "save_note",
      description: "Write down a note on this phone.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note, word for word" },
        },
        required: ["text"],
      },
    },
    {
      name: "find_notes",
      description: "Look through the notes saved on this phone.",
      parameters: {
        type: "object",
        properties: {
          words: { type: "string", description: "What to look for" },
        },
        required: ["words"],
      },
    },
    {
      name: "open_screen",
      description: "Open a part of the OpenBot app.",
      parameters: {
        type: "object",
        properties: {
          screen: {
            type: "string",
            enum: [
              "chats",
              "bots",
              "approvals",
              "needs_you",
              "memory",
              "notes",
            ],
          },
        },
        required: ["screen"],
      },
    },
    {
      name: "message_bot",
      description:
        "Give a message to one of the Bots on the PC. It is sent when the PC can be reached.",
      parameters: {
        type: "object",
        properties: {
          bot: bots.length
            ? { type: "string", enum: bots, description: "Which Bot" }
            : { type: "string", description: "The Bot's name" },
          message: {
            type: "string",
            description: "The message, word for word",
          },
        },
        required: ["bot", "message"],
      },
    },
  ];
}

/** Facts Needle reads the time and place from. Facts, not instructions. */
export function phoneFacts(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${day} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  let locale = "en-US";
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || locale;
  } catch {}
  return `date: ${date}; locale: ${locale}; device: phone; assistant: OpenBot Phone Bot`;
}

/** Reads "YYYY-MM-DD HH:MM" as local time. Exported for tests. */
export function readWhen(value: string): Date | null {
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const when = new Date(year ?? 0, (month ?? 1) - 1, day, hour, minute);
  return Number.isNaN(when.getTime()) ? null : when;
}

export const SCREENS: Record<string, string> = {
  chats: "/",
  bots: "/bots",
  approvals: "/approvals",
  needs_you: "/needs-you",
  memory: "/memory",
};

/** What one job did, in plain words, and where to go if it opens a screen. */
export type Done = { said: string; open?: string; notes?: Note[] };

/** Says, before doing it, what a job is about to do. For "Did you mean…?" */
export function describe(call: NeedleCall): string {
  const a = call.arguments;
  const s = (key: string) =>
    typeof a[key] === "string" ? (a[key] as string) : "";
  switch (call.name) {
    case "remind_me_at":
      return `Remind you "${s("what")}" at ${s("at")}`;
    case "remind_me_in":
      return `Remind you "${s("what")}" in ${String(a.minutes ?? "?")} minutes`;
    case "save_note":
      return `Save the note "${s("text")}"`;
    case "find_notes":
      return `Look through your notes for "${s("words")}"`;
    case "open_screen":
      return `Open ${s("screen").replace("_", " ")}`;
    case "message_bot":
      return `Give ${s("bot")} the message "${s("message")}"`;
    default:
      return call.name;
  }
}

async function remind(what: string, when: Date): Promise<string> {
  if (when.getTime() <= Date.now())
    return "That time has already passed, so I didn't set it.";
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted")
    permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted")
    return "I need permission to show notifications. Allow it in the phone's settings.";
  await Notifications.setNotificationChannelAsync("openbot", {
    name: "OpenBot",
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.scheduleNotificationAsync({
    content: { title: "Reminder", body: what },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: when,
      channelId: "openbot",
    },
  });
  return `Done. I'll remind you "${what}" on ${when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })}.`;
}

export async function doJob(call: NeedleCall): Promise<Done> {
  const a = call.arguments;
  const s = (key: string) =>
    typeof a[key] === "string" ? (a[key] as string).trim() : "";
  const saved = load();
  switch (call.name) {
    case "remind_me_at": {
      const when = readWhen(s("at"));
      if (!when)
        return {
          said: 'I couldn\'t work out the time. Try saying it like "at 5pm tomorrow".',
        };
      return { said: await remind(s("what"), when) };
    }
    case "remind_me_in": {
      const minutes = Number(a.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0)
        return { said: 'I couldn\'t work out how long. Try "in 20 minutes".' };
      return {
        said: await remind(s("what"), new Date(Date.now() + minutes * 60_000)),
      };
    }
    case "save_note": {
      const note = { id: id(), text: s("text"), at: new Date().toISOString() };
      save({ ...saved, notes: [note, ...saved.notes] });
      return { said: "Saved on your phone." };
    }
    case "find_notes": {
      const words = s("words").toLowerCase().split(/\s+/).filter(Boolean);
      const found = saved.notes.filter((note) =>
        words.some((word) => note.text.toLowerCase().includes(word)),
      );
      return found.length
        ? {
            said: `Found ${found.length} ${found.length === 1 ? "note" : "notes"}.`,
            notes: found,
          }
        : { said: "No notes match that." };
    }
    case "open_screen": {
      const screen = s("screen");
      if (screen === "notes")
        return {
          said: `You have ${saved.notes.length} notes.`,
          notes: saved.notes,
        };
      const path = SCREENS[screen];
      return path
        ? { said: "Opening it.", open: path }
        : { said: "I don't know that screen." };
    }
    case "message_bot": {
      const waiting = {
        id: id(),
        bot: s("bot"),
        message: s("message"),
        at: new Date().toISOString(),
      };
      save({ ...saved, outbox: [...saved.outbox, waiting] });
      const sent = await sendWaiting();
      return {
        said: sent.sent.includes(waiting.id)
          ? `Sent to ${waiting.bot}.`
          : `It's waiting on your phone and goes to ${waiting.bot} when the PC can be reached.`,
      };
    }
    default:
      return { said: "I can't do that one on the phone." };
  }
}

export function removeNote(noteId: string) {
  const saved = load();
  save({ ...saved, notes: saved.notes.filter((note) => note.id !== noteId) });
}

export function removeWaiting(waitingId: string) {
  const saved = load();
  save({
    ...saved,
    outbox: saved.outbox.filter((entry) => entry.id !== waitingId),
  });
}

/**
 * Sends what's waiting, if the PC answers. Also keeps the Bots' names for next time offline.
 * Anything that can't go stays, so nothing is lost.
 */
export async function sendWaiting(): Promise<{
  sent: string[];
  reached: boolean;
}> {
  let bots: Bot[];
  let conversations: Conversation[];
  try {
    bots = (await api<{ agents: Bot[] }>("/api/agents")).agents;
    conversations = (
      await api<{ conversations: Conversation[] }>(
        "/api/delivery/conversations",
      )
    ).conversations;
  } catch {
    return { sent: [], reached: false };
  }
  const saved = load();
  const sent: string[] = [];
  const outbox: Waiting[] = [];
  for (const entry of saved.outbox) {
    const bot = bots.find(
      (each) => each.name.toLowerCase() === entry.bot.toLowerCase(),
    );
    const chat = bot
      ? conversations.find(
          (each) => each.active && each.agentIds.includes(bot.id),
        )
      : undefined;
    if (!bot || !chat) {
      outbox.push({
        ...entry,
        problem: bot
          ? `There's no chat with ${bot.name} yet. Start one, and this goes next time.`
          : `There's no Bot called ${entry.bot}.`,
      });
      continue;
    }
    try {
      await api(
        `/api/delivery/conversations/${encodeURIComponent(chat.id)}/messages`,
        {
          method: "POST",
          body: { agentId: bot.id, text: entry.message, externalId: entry.id },
        },
      );
      sent.push(entry.id);
    } catch {
      outbox.push(entry);
    }
  }
  save({ ...load(), outbox, bots: bots.map((bot) => bot.name) });
  return { sent, reached: true };
}
