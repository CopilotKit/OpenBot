import { useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { AgentConsentCard } from "@/components/agents/consent-card";

/**
 * The sign-in a remote ADK agent asks for, answered by the person.
 *
 * Google ADK agents behind an AG-UI endpoint pause their run and emit a tool call named
 * `adk_request_credential` when a tool of theirs needs the person's own account (a per-user OAuth
 * MCP server, for instance). The name is ADK's, not ours; registering it here is what routes that
 * call to a consent card instead of the generic tool line, and what routes the person's answer
 * back as the tool result that resumes the run.
 *
 * `available: false` is the other half: the agent originates this call itself, so the model must
 * never be offered it as something to invoke. The registration exists to answer, not to advertise.
 */
export function AgentCredentialTools() {
  useHumanInTheLoop({
    name: "adk_request_credential",
    description:
      "Answered by the person when an ADK agent asks for their sign-in. Never offered to the model.",
    // The arguments are ADK's own AuthConfig, streamed in as the agent built it. The card reads it
    // defensively; a schema strict enough to be worth having would just be a second copy of ADK.
    parameters: z.record(z.string(), z.unknown()),
    available: false,
    render: AgentConsentCard as Parameters<
      typeof useHumanInTheLoop
    >[0]["render"],
  });
  return null;
}
