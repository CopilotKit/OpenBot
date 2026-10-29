import { createContext, useEffect, useRef, useState } from "react";

/** The part of the CopilotKit core this needs: its activity renderers, and a way to hear it connect. */
type RendererCore = {
  readonly renderActivityMessages: readonly unknown[];
  subscribe(subscriber: { onRuntimeConnectionStatusChanged?: () => void }): {
    unsubscribe(): void;
  };
};

/** How many frames, after a trigger, to keep looking for the provider's swap before giving up. */
const LOOK_FRAMES = 10;

/**
 * A version that goes up when the core's activity renderers change.
 *
 * The provider swaps that list in a passive effect when generative UI turns on (the capabilities
 * answer arriving, `settled` here, or the runtime connecting) and notifies nobody, so an activity
 * that rendered before then drew nothing and stayed that way until its own message changed. This
 * looks again after each of those, ONE FRAME at a time for up to LOOK_FRAMES, because the provider's
 * effect runs after this one and, under a cold start, can land a few frames later; it counts a change
 * only when the list really is a different list.
 */
export function useLateRenderers(
  core: RendererCore,
  waiting: boolean,
  settled: unknown,
): number {
  const [version, setVersion] = useState(0);
  // The list last looked at, kept across looks so a change made before one is not missed.
  const seenRef = useRef(core.renderActivityMessages);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `settled` is the trigger, not an input
  useEffect(() => {
    if (!waiting) return;
    let frame = 0;
    const look = (left = LOOK_FRAMES) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (core.renderActivityMessages !== seenRef.current) {
          seenRef.current = core.renderActivityMessages;
          setVersion((current) => current + 1);
        } else if (left > 1) {
          look(left - 1);
        }
      });
    };
    const subscription = core.subscribe({
      onRuntimeConnectionStatusChanged: () => look(),
    });
    look();
    return () => {
      window.cancelAnimationFrame(frame);
      subscription.unsubscribe();
    };
  }, [core, waiting, settled]);

  return version;
}

/**
 * The renderers' version for every activity in a transcript. Read by an activity so it redraws when
 * the renderers it found missing arrive; see `LateRenderersWatch`.
 */
export const LateRenderersContext = createContext(0);

/**
 * ONE subscription for a whole transcript. Each activity used to carry its own — a core
 * subscription, a capabilities observer and a frame poll per row — to patch a signal the SDK does
 * not send; here it is listened for once and handed up, for the transcript to pass down through
 * `LateRenderersContext`.
 *
 * Renders nothing, so the transcript can mount it only while it has activities without changing the
 * shape of its own tree (which would remount every row).
 */
export function LateRenderersWatch({
  core,
  settled,
  onVersion,
}: {
  core: RendererCore;
  settled: unknown;
  onVersion: (version: number) => void;
}) {
  const version = useLateRenderers(core, true, settled);
  useEffect(() => {
    if (version > 0) onVersion(version);
  }, [version, onVersion]);
  return null;
}
