import { createRoot } from "react-dom/client";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { installDesktopShell } from "./desktop-shell.fixture";

/**
 * The message box on a page of its own, for composer-dictation-notice-layout.test.tsx to bundle and
 * load in Chromium. OpenBot has no transcription provider, and this is the Desktop window on a
 * computer with no microphone: the desktop app answers every start with `audio-capture`, as
 * speech.rs does, so the microphone's notice shows above the box.
 *
 * `?layout=home` is Home's empty page, the box centred under the greeting, with the classes of
 * `routes/_authed/_app/index.tsx`. `?layout=thread` is a conversation's, the compact box in a block
 * of its own under the transcript, with the classes of `conversation-view.tsx`. `?theme=dark` draws
 * it dark.
 */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");

queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  transcription: false,
});
installDesktopShell({ fails: "audio-capture" });

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    params.get("layout") === "thread" ? (
      <div className="flex h-screen flex-col bg-background">
        <div className="min-h-0 flex-1 p-4 text-sm">
          A conversation above the box.
        </div>
        <div className="mx-auto w-full max-w-[calc(var(--container-3xl)+2rem)] shrink-0 px-4 pb-4">
          <Composer
            className="relative w-full mt-auto"
            compact
            onSubmit={() => {}}
          />
        </div>
      </div>
    ) : (
      <div className="flex min-h-screen flex-col bg-background">
        <div className="flex-1 flex flex-col items-center justify-center w-full p-4 mt-8">
          <div className="flex flex-col items-center">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Start a conversation
            </h1>
          </div>
          <div className="mt-8 w-full flex flex-col items-center">
            <Composer className="w-full max-w-2xl" onSubmit={() => {}} />
            <p className="mt-2 w-full max-w-2xl text-xs text-muted-foreground text-center">
              OpenBot picks the right Bot. Type @ to choose one.
            </p>
          </div>
        </div>
      </div>
    ),
  );
}
