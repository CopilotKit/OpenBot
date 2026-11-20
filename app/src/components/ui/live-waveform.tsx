/**
 * Adapted from ElevenLabs UI LiveWaveform (static mirrored bars and edge fade):
 * https://github.com/elevenlabs/ui/blob/main/apps/www/registry/elevenlabs-ui/ui/live-waveform.tsx
 * OpenBot supplies its existing recording stream; this component never opens or stops a microphone.
 *
 * MIT License
 * Copyright (c) 2025 Eleven Labs Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function LiveWaveform({
  stream,
  processing = false,
  height = 32,
  className,
}: {
  stream?: MediaStream;
  processing?: boolean;
  height?: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduceMotion = useReducedMotion();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let audioContext: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let samples: Uint8Array<ArrayBuffer> | undefined;
    let disposed = false;
    setUnavailable(false);
    if (stream) {
      try {
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        samples = new Uint8Array(analyser.frequencyBinCount);
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        void audioContext.resume().catch(() => {
          if (!disposed) setUnavailable(true);
        });
      } catch {
        // Visualization can fail independently; the user's audio still records.
        setUnavailable(true);
      }
    }
    let width = 0;
    let lastUpdate = 0;
    let frame = 0;
    const bars: number[] = [];
    const resize = () => {
      width = container.getBoundingClientRect().width;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (time - lastUpdate < (reduceMotion ? 120 : 30)) return;
      lastUpdate = time;
      if (analyser && samples) analyser.getByteFrequencyData(samples);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      const count = Math.floor(width / 5);
      const half = Math.max(1, count / 2);
      for (let i = 0; i < count; i++) {
        const position = Math.abs(i - half) / half;
        let value = 0;
        if (samples) {
          const index = Math.floor(samples.length * (0.05 + position * 0.35));
          value = (samples[index] ?? 0) / 255;
        } else if (processing && !reduceMotion) {
          value = Math.max(
            0.05,
            (0.25 + Math.sin(time / 450 + position * 3) * 0.18) *
              (1 - position * 0.4),
          );
        }
        bars[i] = reduceMotion
          ? value
          : (bars[i] ?? 0) + (value - (bars[i] ?? 0)) * 0.4;
        const barHeight = Math.max(3, bars[i] * height * 0.85);
        const edge = Math.min(1, (i * 5) / 20, (width - i * 5) / 20);
        context.globalAlpha = (0.4 + bars[i] * 0.6) * Math.max(0, edge);
        context.beginPath();
        context.roundRect(i * 5, (height - barHeight) / 2, 3, barHeight, 1.5);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      source?.disconnect();
      analyser?.disconnect();
      if (audioContext && audioContext.state !== "closed") {
        void audioContext
          .close()
          .catch((error: unknown) =>
            console.warn("Could not close waveform audio context", error),
          );
      }
    };
  }, [stream, processing, height, reduceMotion]);

  return (
    <div
      ref={containerRef}
      className={cn("relative min-w-0 w-full", className)}
      style={{ height }}
      role="img"
      aria-label={
        unavailable
          ? "Waveform unavailable; recording continues"
          : processing
            ? "Processing audio"
            : "Live audio waveform"
      }
    >
      <canvas ref={canvasRef} className="block size-full" />
      {unavailable && (
        <span className="absolute inset-0 flex items-center bg-card text-xs text-muted-foreground">
          Recording · waveform unavailable
        </span>
      )}
    </div>
  );
}
