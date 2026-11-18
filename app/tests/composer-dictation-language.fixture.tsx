import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { installDesktopShell } from "./desktop-shell.fixture";

/**
 * A conversation's message box on a page of its own, for composer-dictation-language.test.tsx to
 * bundle and load in Chromium and WebKit. OpenBot has no transcription provider, and this is the
 * Desktop window on a Mac whose recognizer has no English (United Kingdom) on the device:
 *
 * - `?case=fallback`: it has English (United States), and hears a few words once listening.
 * - `?case=none`: it has no language at all.
 *
 * The browser's locale is the page's language. `?theme=dark` draws it dark.
 */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");

queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  transcription: false,
});
const fallback = params.get("case") === "fallback";
const { calls } = installDesktopShell({
  availability: (language) =>
    fallback && language === "en-US" ? "available" : "unavailable",
  heard: [
    { type: "result", index: 0, text: "book a table", final: false },
    { type: "result", index: 0, text: "book a table for two", final: false },
  ],
});
/** What the page asked the desktop app, for the test to read. */
(window as { shellCalls?: unknown }).shellCalls = calls;

function Thread() {
  return (
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
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <Thread />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
