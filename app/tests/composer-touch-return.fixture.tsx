import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Composer } from "@/components/channels/composer/composer";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

/**
 * The message box on a page of its own, for composer-touch-return.test.tsx to bundle and load in a
 * browser. Every message it sends is kept on `window.sent`, so the test can read whether a key
 * sent one.
 *
 * `?layout=thread` is a conversation's compact box pinned under the transcript, with the classes of
 * `conversation-view.tsx`; anything else is Home's box, centred. `?theme=dark` draws it dark.
 */
declare global {
  interface Window {
    sent: string[];
  }
}
window.sent = [];

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");

queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  transcription: false,
});
queryClient.setQueryData(authKeys.currentUser(), {
  id: "u-1",
  name: "Dana Reyes",
  email: "dana@example.com",
});

const send = async (draft: { text: string }) => {
  window.sent.push(draft.text);
};

function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <Composer className="w-full max-w-2xl" onSubmit={send} />
    </div>
  );
}

function Thread() {
  return (
    <div className="flex h-svh flex-col bg-background">
      <div className="min-h-0 flex-1 p-4 text-sm">
        A conversation above the box.
      </div>
      <div className="mx-auto w-full max-w-[calc(var(--container-3xl)+2rem)] shrink-0 px-4 pb-4">
        <Composer className="relative w-full mt-auto" compact onSubmit={send} />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        {params.get("layout") === "thread" ? <Thread /> : <Home />}
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
