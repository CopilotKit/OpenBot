import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { ActiveBotProvider } from "./active-bot";
import { ComputerTools } from "./computer-tools";
import { EscalationTool } from "./escalation-tool";
import { GalleryTools } from "./gallery-tools";
import { GENERATIVE_UI_DESIGN_SKILL } from "./generative-ui";
import { HandoffTool } from "./handoff-tool";
import { SandboxedTools } from "./sandboxed-tools";

/**
 * The CopilotKit client, wrapped once for the whole authenticated app.
 *
 * `credentials: "include"` is the load-bearing part. OpenBot authenticates with a Better Auth
 * session cookie, and the runtime endpoint sits behind the same guard as every other API route, so
 * without it every run is rejected as anonymous while the rest of the app looks signed in.
 *
 * The URL is relative, like every other call in the app, so the Vite dev proxy and a single-origin
 * deployment both work without a build-time base URL to get wrong.
 *
 * There is no `publicApiKey`. The Intelligence key and licence token are deployment secrets held by
 * the server; a browser never sees them (see server/src/app.ts, where /api/capabilities projects the
 * runtime rather than returning it).
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());

  return (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      credentials="include"
      /*
       * Passed only when this deployment actually has the capability, and this is the load-bearing
       * part rather than a tidiness. The SDK reads generative UI as on when EITHER the runtime says
       * so OR this prop is present at all, so passing it unconditionally would switch the browser
       * half on in a deployment that had switched the server half off. The Bot would then be offered
       * the tool, generate a whole interface, and nothing would draw it, because the events that
       * paint one come from the runtime middleware this deployment declined to run.
       *
       * Absent, the SDK asks the runtime and believes the answer, which is the behaviour we want
       * while this query is still in flight.
       *
       * The object carries guidance only. It does not turn anything on that the server has not
       * already turned on; it replaces the SDK's shadcn-flavoured house style with OpenBot's.
       */
      {...(capabilities?.generativeUi
        ? { openGenerativeUI: { designSkill: GENERATIVE_UI_DESIGN_SKILL } }
        : {})}
    >
      {/* Computer tools target the Bot declared by the mounted surface. */}
      <ActiveBotProvider>
        <ComputerTools />
        {/*
          Draws a Bot bringing in another Bot. Registers no tool: `message_bot` runs on the server,
          where the grant and the caps are. A hop that happens off-screen is the thing to avoid.
        */}
        <HandoffTool />
        <EscalationTool />
        {/* Gallery tools are registered once; their handlers re-read the active Bot to avoid shadowing renderers. */}
        <GalleryTools />
        {/* Browser-authored components use the same component grants as the compiled gallery. */}
        <SandboxedTools />
        {children}
      </ActiveBotProvider>
    </CopilotKitProvider>
  );
}
