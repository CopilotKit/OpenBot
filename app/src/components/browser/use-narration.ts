import { useCallback, useEffect, useRef, useState } from "react";
import { sendNarration } from "@/lib/browser/mutations";
import {
  browserNarrationDeps,
  type Narration,
  type NarrationDeps,
  type NarrationStatus,
  startNarration,
} from "@/lib/browser/narration";

/** The longest phrase the narration route takes. */
const PHRASE_MAX = 4000;

/**
 * The person's narration while a recording runs in the browser the page shows: listening from when `listening` turns
 * on, each final phrase sent to the Recorder as it comes, and a mute that lasts across recordings.
 *
 * `finish` is for Stop. It hands over the phrase in progress and waits until every phrase has reached the server, so
 * the last thing the person said is in the recording before the recording ends.
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
  const [lostPhrase, setLostPhrase] = useState(false);
  const session = useRef<Narration | null>(null);
  const sending = useRef(new Set<Promise<boolean>>());
  const mutedNow = useRef(muted);
  mutedNow.current = muted;
  const depsNow = useRef(deps);
  depsNow.current = deps;
  const supported = (deps ?? browserNarrationDeps()).Recognition !== null;

  useEffect(() => {
    if (!listening) {
      setStatus(null);
      return;
    }
    setLostPhrase(false);
    const narration = startNarration(
      {
        language,
        muted: mutedNow.current,
        phrase: (phrase) => {
          const sent = sendNarration({
            ...phrase,
            text: phrase.text.slice(0, PHRASE_MAX),
          });
          sending.current.add(sent);
          void sent.then((arrived) => {
            sending.current.delete(sent);
            if (!arrived) setLostPhrase(true);
          });
        },
        status: setStatus,
      },
      depsNow.current ?? browserNarrationDeps(),
    );
    session.current = narration;
    return () => {
      if (session.current === narration) session.current = null;
      void narration.stop();
    };
  }, [listening, language]);

  useEffect(() => {
    session.current?.mute(muted);
  }, [muted]);

  const finish = useCallback(async () => {
    const narration = session.current;
    session.current = null;
    await narration?.stop();
    await Promise.all(sending.current);
  }, []);

  return { supported, muted, setMuted, status, lostPhrase, finish };
}

export type NarrationControls = ReturnType<typeof useNarration>;
