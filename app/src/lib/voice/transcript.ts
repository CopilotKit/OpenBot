import type { VoiceTranscriptEntry } from "../../../../shared/voice-session";
import type { VoiceEvent } from "./types";

export const VOICE_CONTEXT_ITEM_ID = "openbot-voice-context";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Item IDs preserve turn order even when input transcription finishes after the reply. */
export class VoiceTranscript {
  private entries = new Map<string, VoiceTranscriptEntry>();
  private characters = 0;
  private interrupted = new Set<string>();
  private lastAssistantId?: string;
  private playing = false;
  full = false;

  read(): VoiceTranscriptEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.text.trim())
      .map((entry) => ({ ...entry }));
  }

  receive(event: VoiceEvent) {
    if (event.type === "output_audio_buffer.started") this.playing = true;
    if (event.type === "output_audio_buffer.stopped") this.playing = false;
    if (event.type === "output_audio_buffer.cleared" && this.playing) {
      if (this.lastAssistantId) this.interrupt(this.lastAssistantId);
      this.playing = false;
    }
    const item = object(event.item);
    const id =
      typeof event.item_id === "string"
        ? event.item_id
        : typeof item?.id === "string"
          ? item.id
          : undefined;
    if (!id || id === VOICE_CONTEXT_ITEM_ID) return;
    if (event.type === "conversation.item.truncated") this.interrupt(id);
    if (this.interrupted.has(id)) return;
    if (event.type === "input_audio_buffer.committed") this.set(id, "user", "");
    if (
      item?.type === "message" &&
      (item.role === "user" || item.role === "assistant")
    ) {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map((part) => {
          const value = object(part);
          return typeof value?.transcript === "string"
            ? value.transcript
            : typeof value?.text === "string"
              ? value.text
              : "";
        })
        .join("");
      this.set(id, item.role, text);
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      typeof event.transcript === "string"
    )
      this.set(id, "user", event.transcript);
    if (
      event.type === "response.output_audio_transcript.delta" &&
      typeof event.delta === "string"
    )
      this.set(
        id,
        "assistant",
        (this.entries.get(id)?.text ?? "") + event.delta,
      );
    if (
      event.type === "response.output_audio_transcript.done" &&
      typeof event.transcript === "string"
    )
      this.set(id, "assistant", event.transcript);
  }

  private set(id: string, role: VoiceTranscriptEntry["role"], text: string) {
    const existing = this.entries.get(id);
    const nextText = text || existing?.text || "";
    const total =
      this.characters - (existing?.text.length ?? 0) + nextText.length;
    if ((!existing && this.entries.size >= 300) || total > 60_000) {
      this.full = true;
      return;
    }
    this.characters = total;
    if (role === "assistant") this.lastAssistantId = id;
    // Empty item lifecycle events must not overwrite a completed transcript.
    this.entries.set(id, { id, role, text: nextText });
  }

  private interrupt(id: string) {
    const entry = this.entries.get(id);
    if (entry?.role !== "assistant") return;
    // Providers don't give word timestamps. Do not present queued, unplayed text as heard speech.
    this.set(
      id,
      "assistant",
      "[Response interrupted; the exact words heard are unavailable.]",
    );
    this.interrupted.add(id);
  }
}
