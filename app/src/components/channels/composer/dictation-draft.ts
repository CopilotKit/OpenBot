import {
  mergeAdjacentTextSegments,
  type Segment,
  text,
} from "prompt-area/helpers";

/** Append to the latest draft, preserving agent/skill chips and edits made during transcription. */
export function appendDictation(
  segments: Segment[],
  transcript: string,
): Segment[] {
  const words = transcript.trim();
  if (!words) return segments;
  const last = segments.at(-1);
  const separator =
    last &&
    (last.type !== "text" || (last.text.length > 0 && !/\s$/.test(last.text)))
      ? " "
      : "";
  return mergeAdjacentTextSegments([...segments, text(separator + words)]);
}
