export type VoiceTranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type SaveVoiceSessionInput = {
  id: string;
  channelId: string;
  anchorMessageId: string | null;
  startedAt: string;
  endedAt: string;
  transcript: VoiceTranscriptEntry[];
};

export type VoiceSessionRecord = SaveVoiceSessionInput & {
  durationSeconds: number;
  summary: string | null;
  summaryStatus: "ready" | "failed";
};

export type VoiceSessionPage = {
  sessions: VoiceSessionRecord[];
  nextCursor: string | null;
};
