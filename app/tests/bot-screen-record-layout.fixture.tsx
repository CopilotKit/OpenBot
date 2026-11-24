import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ComputerView } from "@/components/computer/computer-view";
import { setCurrentOrganization } from "@/lib/organizations/current";

/**
 * A Bot's screen as the Computer beside a conversation draws it, as a page of its own for
 * bot-screen-record-layout.test.tsx and bot-screen-sharp.test.tsx to bundle and load in a browser: the real
 * `ComputerView`, which each test opens full size. What the server answers (the screen, who has control, the Bot's
 * browser) comes from the test's routes.
 *
 * The page has no sign-in in front of it, so it starts in `default`, the organization those routes answer for, as
 * every test does (preload.ts, which a page loaded in a browser does not run).
 */
setCurrentOrganization("default");

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <div style={{ width: 380 }}>
        <ComputerView
          active
          computerId="fernhill-guide"
          name="Fernhill Guide"
        />
      </div>
    </QueryClientProvider>,
  );
