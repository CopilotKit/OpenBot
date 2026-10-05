import { decodePcm, encodePcm } from "./pcm";
import type { ConnectVoice, VoiceEvent } from "./types";

const RATE = 24000;
type Playing = {
  source: AudioBufferSourceNode;
  itemId: string;
  index: number;
  start: number;
  end: number;
  offset: number;
};

/** Grok's WebSocket transport owns PCM capture, audio scheduling and interruption truncation. */
export const connectWebSocket: ConnectVoice = async ({
  channelId,
  signal,
  onEvent,
  onError,
  onOutput,
}) => {
  signal.throwIfAborted();
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let capture: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let silent: GainNode | undefined;
  let output: MediaStreamAudioDestinationNode | undefined;
  let socket: WebSocket | undefined;
  let closed = false;
  let configured = false;
  let nextPlayback = 0;
  let responseId: string | undefined;
  let interruptedResponse: string | undefined;
  const playing: Playing[] = [];
  const offsets = new Map<string, number>();
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => undefined);

  const stopPlayback = () => {
    for (const item of playing.splice(0)) {
      item.source.onended = null;
      item.source.stop();
      item.source.disconnect();
    }
    nextPlayback = context?.currentTime ?? 0;
    onEvent({ type: "output_audio_buffer.cleared" });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    ready.reject(new DOMException("Call ended", "AbortError"));
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null;
      socket.close();
    }
    stopPlayback();
    capture?.disconnect();
    if (capture) capture.port.onmessage = null;
    source?.disconnect();
    silent?.disconnect();
    output?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (context && context.state !== "closed")
      void context
        .close()
        .catch(() => console.warn("Could not close the voice audio context."));
  };
  const fail = (message: string) => {
    if (closed) return;
    ready.reject(new Error(message));
    close();
    onError(new Error(message));
  };
  const send = (event: VoiceEvent) => {
    if (closed || socket?.readyState !== WebSocket.OPEN)
      throw new Error("The voice call is no longer connected.");
    socket.send(JSON.stringify(event));
  };
  signal.addEventListener("abort", close, { once: true });

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (closed || signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("Call ended", "AbortError");
    }
    context = new AudioContext({ sampleRate: RATE });
    await context.resume();
    if (
      context.sampleRate !== RATE ||
      !context.audioWorklet ||
      context.state !== "running"
    ) {
      throw new Error(
        "This browser could not start call audio. Allow sound and try again.",
      );
    }
    await context.audioWorklet.addModule(
      new URL("./pcm-worklet.js", import.meta.url),
    );
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, "voice-capture");
    silent = context.createGain();
    silent.gain.value = 0;
    source.connect(capture);
    capture.connect(silent).connect(context.destination);
    output = context.createMediaStreamDestination();
    onOutput(output.stream);

    const response = await fetch("/api/voice/calls", {
      method: "POST",
      credentials: "include",
      signal,
      headers: { "Content-Type": "application/json", "x-openbot-voice": "1" },
      body: JSON.stringify({ channelId }),
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
          ? body.error
          : "Could not start the voice call.",
      );
    if (
      !body ||
      typeof body !== "object" ||
      !("transport" in body) ||
      body.transport !== "websocket" ||
      !("url" in body) ||
      typeof body.url !== "string" ||
      !("clientSecret" in body) ||
      typeof body.clientSecret !== "string" ||
      !("session" in body) ||
      !body.session ||
      typeof body.session !== "object"
    )
      throw new Error("Invalid voice connection configuration.");
    const address = new URL(body.url);
    if (
      address.origin !== "wss://api.x.ai" ||
      address.pathname !== "/v1/realtime"
    )
      throw new Error("Unsupported voice service address.");
    signal.throwIfAborted();
    socket = new WebSocket(body.url, [
      `xai-client-secret.${body.clientSecret}`,
    ]);
    const ws = socket;
    const audio = context;
    const destination = output;
    ws.onopen = () => send({ type: "session.update", session: body.session });
    ws.onerror = () =>
      fail(
        "Could not connect to Grok Voice. Check your connection and try again.",
      );
    ws.onclose = () =>
      fail("The voice connection closed. Your chat is still available.");
    ws.onmessage = ({ data }) => {
      if (closed) return;
      try {
        const raw: unknown = JSON.parse(data);
        if (
          !raw ||
          typeof raw !== "object" ||
          !("type" in raw) ||
          typeof raw.type !== "string"
        )
          throw new Error("Invalid voice event.");
        const event = raw as VoiceEvent;
        if (event.type === "session.updated") {
          configured = true;
          ready.resolve();
        }
        if (event.type === "response.created") {
          const response = event.response;
          if (
            response &&
            typeof response === "object" &&
            "id" in response &&
            typeof response.id === "string"
          )
            responseId = response.id;
        }
        if (event.type === "input_audio_buffer.speech_started") {
          interruptedResponse = responseId;
          const now = audio.currentTime;
          const active = playing.find((item) => item.end > now);
          if (active)
            send({
              type: "conversation.item.truncate",
              item_id: active.itemId,
              content_index: active.index,
              audio_end_ms: Math.floor(
                active.offset + Math.max(0, now - active.start) * 1000,
              ),
            });
          stopPlayback();
        }
        if (
          event.type === "response.output_audio.delta" ||
          event.type === "response.audio.delta"
        ) {
          if (
            interruptedResponse &&
            (event.response_id ?? responseId) === interruptedResponse
          )
            return;
          if (
            typeof event.delta !== "string" ||
            typeof event.item_id !== "string"
          )
            throw new Error("Invalid audio event.");
          const samples = decodePcm(event.delta);
          if (!samples.length) return;
          if (nextPlayback - audio.currentTime > 30)
            throw new Error(
              "Voice playback could not keep up. Please call again.",
            );
          const buffer = audio.createBuffer(1, samples.length, RATE);
          buffer.copyToChannel(samples, 0);
          const node = audio.createBufferSource();
          node.buffer = buffer;
          node.connect(audio.destination);
          node.connect(destination);
          const start = Math.max(audio.currentTime, nextPlayback);
          const offset = offsets.get(event.item_id) ?? 0;
          const item: Playing = {
            source: node,
            itemId: event.item_id,
            index:
              typeof event.content_index === "number" ? event.content_index : 0,
            start,
            end: start + buffer.duration,
            offset,
          };
          if (offsets.size > 128) offsets.clear();
          offsets.set(event.item_id, offset + buffer.duration * 1000);
          if (!playing.length) onEvent({ type: "output_audio_buffer.started" });
          playing.push(item);
          nextPlayback = item.end;
          node.onended = () => {
            const index = playing.indexOf(item);
            if (index >= 0) playing.splice(index, 1);
            node.disconnect();
            if (!playing.length && !closed)
              onEvent({ type: "output_audio_buffer.stopped" });
          };
          node.start(start);
          return;
        }
        // Older Grok sessions use the shorter event name; consumers only see the normalized form.
        if (event.type === "response.audio_transcript.delta")
          event.type = "response.output_audio_transcript.delta";
        if (event.type === "response.audio_transcript.done")
          event.type = "response.output_audio_transcript.done";
        onEvent(event);
      } catch {
        fail(
          "The voice service sent invalid audio or controls. Please call again.",
        );
      }
    };
    capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (closed || !configured || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) {
        fail("Your connection is too slow for live audio. Please call again.");
        return;
      }
      send({ type: "input_audio_buffer.append", audio: encodePcm(data) });
    };
    for (const track of stream.getAudioTracks())
      track.onended = () =>
        fail("The microphone disconnected. Check it and call again.");
    await ready.promise;
    signal.throwIfAborted();
    const microphone = stream;
    return {
      stream,
      send,
      close,
      mute(muted) {
        for (const track of microphone.getAudioTracks()) track.enabled = !muted;
        if (muted) send({ type: "input_audio_buffer.clear" });
      },
    };
  } catch (error) {
    close();
    throw error;
  }
};
