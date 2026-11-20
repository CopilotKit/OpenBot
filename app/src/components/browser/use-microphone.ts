import { useEffect, useState } from "react";

/**
 * Whether this computer has a microphone: true, false, or undefined while it is not known (not asked yet, or a page
 * that cannot tell). Asked again whenever a device comes or goes, so one plugged in later counts at once.
 *
 * Narration on a computer with no microphone falls back to off once a recording tries it, but the page cannot remember
 * that past a relaunch: it read "Narration is on." again, with the switch on and nothing to hear with (seen on Windows,
 * in the OpenBot Desktop window). This answers before any recording, without opening the microphone.
 */
export function useMicrophone(): boolean | undefined {
  const [present, setPresent] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    const devices = globalThis.navigator?.mediaDevices;
    if (!devices?.enumerateDevices) return;
    let current = true;
    const ask = () => {
      void microphonePresent(devices).then((found) => {
        if (current) setPresent(found);
      });
    };
    ask();
    devices.addEventListener?.("devicechange", ask);
    return () => {
      current = false;
      devices.removeEventListener?.("devicechange", ask);
    };
  }, []);
  return present;
}

/**
 * Whether `devices` lists a microphone. Chromium, WebView2 included, lists one device of each kind it has before the
 * page may use any, so a list with no microphone means there is none. WebKit may list nothing at all until the page has
 * used one, and an empty list there says nothing, so it is not known.
 */
export async function microphonePresent(
  devices: Pick<MediaDevices, "enumerateDevices">,
  chromium = isChromium(),
): Promise<boolean | undefined> {
  try {
    const listed = await devices.enumerateDevices();
    if (listed.some((device) => device.kind === "audioinput")) return true;
    return listed.length > 0 || chromium ? false : undefined;
  } catch {
    return undefined;
  }
}

type UserAgentData = { brands?: { brand: string }[] };

function isChromium(): boolean {
  const data = (globalThis.navigator as { userAgentData?: UserAgentData })
    ?.userAgentData;
  return !!data?.brands?.some((entry) => entry.brand === "Chromium");
}
