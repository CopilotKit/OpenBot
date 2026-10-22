import { useCallback, useEffect, useRef, useState } from "react";
import { type NarrationPost, sendNarration } from "@/lib/browser/mutations";
import {
  browserNarrationDeps,
  type Narration,
  type NarrationDeps,
  type NarrationStatus,
  startNarration,
} from "@/lib/browser/narration";

/** The longest phrase the narration route takes. */
const PHRASE_MAX = 4000;

/** A narration post that did not arrive: the server's sentence for why, or null when it gave none. */
export type LostNarration = { error: string | null };

/**
 * The person's narration while a recording runs in the browser the page shows: listening from when `listening` turns
 * on, and a mute that lasts across recordings. Everything the Recorder needs to place what they say among their steps
 * goes to it in the order it happened: that a phrase began (its first words came back), the phrase once it is final,
 * and that they stopped speaking. One post at a time, each after the last has been answered, because a phrase that
 * overtook the word that it began would leave the Recorder holding the person's steps for a phrase already placed.
 *
 * `finish` is for Stop. It hands over the phrase in progress and waits until every post has been answered, so the
 * last thing the person said is in the recording before the recording ends.
 */
export function useNarration({
  listening,
  language,
  deps,
}: {
  listening: boolean;
  language: string;
  /** The browser's own recognition and clock unless a test gives others. */
  deps?: NarrationDeps;
}) {
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState<NarrationStatus | null>(null);
  const [lost, setLost] = useState<LostNarration | null>(null);
  const session = useRef<Narration | null>(null);
  /** The last post, answered or not: the next one goes after it. */
  const posted = useRef<Promise<void>>(Promise.resolve());
  const mutedNow = useRef(muted);
  mutedNow.current = muted;
  const depsNow = useRef(deps);
  depsNow.current = deps;
  const supported = (deps ?? browserNarrationDeps()).Recognition !== null;

  const post = useCallback((body: NarrationPost) => {
    posted.current = posted.current.then(async () => {
      const answer = await sendNarration(body);
      if (!answer.ok) setLost({ error: answer.error });
    });
  }, []);

  useEffect(() => {
    if (!listening) {
      setStatus(null);
      return;
    }
    setLost(null);
    const narration = startNarration(
      {
        language,
        muted: mutedNow.current,
        phrase: (phrase) =>
          post({ ...phrase, text: phrase.text.slice(0, PHRASE_MAX) }),
        speaking: (since) =>
          post(
            since === null ? { speaking: false } : { speaking: true, since },
          ),
        status: setStatus,
      },
      depsNow.current ?? browserNarrationDeps(),
    );
    session.current = narration;
    return () => {
      if (session.current === narration) session.current = null;
      void narration.stop();
    };
  }, [listening, language, post]);

  useEffect(() => {
    session.current?.mute(muted);
  }, [muted]);

  const finish = useCallback(async () => {
    const narration = session.current;
    session.current = null;
    await narration?.stop();
    await posted.current;
  }, []);

  /**
   * Whether narration is on as it really is, which the switch shows. Muted is off. So is a narration that failed and
   * stopped listening (no microphone, or the browser refused it): the page says narration is off then, and a switch that
   * still read on contradicted it (seen in the fourth end-to-end run, in a browser with no microphone). A speech service
   * that could not be reached is still on: narration tries again by itself.
   */
  const stopped = status?.state === "failed" && status.problem !== "network";
  const on = !muted && !stopped;

  /** Turns narration on or off. On after a failure tries again: the person was never muted, so muting alone would not. */
  const setOn = useCallback((next: boolean) => {
    setMuted(!next);
    if (next) session.current?.mute(false);
  }, []);

  return { supported, on, setOn, status, lost, finish };
}

export type NarrationControls = ReturnType<typeof useNarration>;
