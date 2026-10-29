import { useEffect, useRef, useState } from "react";

/** The part of the CopilotKit core this needs: its activity renderers, and a way to hear it connect. */
type RendererCore = {
  readonly renderActivityMessages: readonly unknown[];
  subscribe(subscriber: { onRuntimeConnectionStatusChanged?: () => void }): {
    unsubscribe(): void;
  };
};

/**
 * A version that goes up when the core's activity renderers change, for an activity that has none.
 *
 * The provider swaps that list in a passive effect when generative UI turns on (the capabilities
 * answer arriving, `settled` here, or the runtime connecting) and notifies nobody, so an activity
 * that rendered before then drew nothing and stayed that way until its own message changed. This
 * looks again ONE FRAME after each of those, because the provider's effect runs after this one, and
 * only counts a change when the list really is a different list.
 */
export function useLateRenderers(
  core: RendererCore,
  waiting: boolean,
  settled: unknown,
): number {
  const [version, setVersion] = useState(0);
  // The list this activity last looked at, kept across looks so a change made before one is not missed.
  const seenRef = useRef(core.renderActivityMessages);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `settled` is the trigger, not an input
  useEffect(() => {
    if (!waiting) return;
    let frame = 0;
    const look = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (core.renderActivityMessages !== seenRef.current) {
          seenRef.current = core.renderActivityMessages;
          setVersion((current) => current + 1);
        }
      });
    };
    const subscription = core.subscribe({
      onRuntimeConnectionStatusChanged: look,
    });
    look();
    return () => {
      window.cancelAnimationFrame(frame);
      subscription.unsubscribe();
    };
  }, [core, waiting, settled]);

  return version;
}
