/**
 * The setup screens, rendered without the shell around them, so they can be looked at.
 *
 * Not shipped: vite builds index.html and nothing points here. The catalogues below are a SNAPSHOT
 * taken from the Rust side, not a second source of truth — the app itself reads the real thing over
 * `invoke`. If a row here disagrees with the picker in the running app, this file is the stale one.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HarnessPicker } from "./HarnessPicker";
import { type ModelChoice, ProviderPicker } from "./ProviderPicker";
import "./styles.css";

const CATALOGUES: Record<string, unknown> = {
  harnesses: [
    {
      id: "crewai",
      name: "CrewAI",
      summary: "Crews of agents with roles and tasks.",
      image: "openbot-harness-crewai",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "partnership",
      mark: "crewai",
    },
    {
      id: "llamaindex",
      name: "LlamaIndex",
      summary: "Agents built around your own documents.",
      image: "openbot-harness-llamaindex",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: "llamaindex",
    },
    {
      id: "agno",
      name: "Agno",
      summary: "Fast, small, and multi-modal.",
      image: "openbot-harness-agno",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: null,
    },
    {
      id: "langgraph",
      name: "LangGraph",
      summary: "Graphs you can change, from LangChain.",
      image: "openbot-harness-langgraph",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "partnership",
      mark: "langgraph",
    },
    {
      id: "google-adk",
      name: "Google ADK",
      summary: "Google's agent kit. Gemini first, any model after.",
      image: "openbot-harness-google-adk",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: "google-adk",
    },
    {
      id: "pydantic-ai",
      name: "Pydantic AI",
      summary: "Typed agents, validated in and out.",
      image: "openbot-harness-pydantic-ai",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: "pydantic-ai",
    },
    {
      id: "microsoft-agent-framework",
      name: "Microsoft Agent Framework",
      summary: "Microsoft's, model-agnostic by design.",
      image: "openbot-harness-microsoft-agent-framework",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: "microsoft-agent-framework",
    },
    {
      id: "claude-agent-sdk",
      name: "Claude Agent SDK",
      summary:
        "Anthropic's own. The one that takes a Claude plan instead of a key.",
      image: "openbot-harness-claude-agent-sdk",
      health_path: "/health",
      credential: "anthropic",
      maintainer: "community",
      mark: "claude-agent-sdk",
    },
    {
      id: "strands",
      name: "AWS Strands",
      summary: "Amazon's. Bedrock first, any model after.",
      image: "openbot-harness-strands",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: "strands",
    },
    {
      id: "ag2",
      name: "AG2",
      summary: "The AutoGen line, continued.",
      image: "openbot-harness-ag2",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "first-party",
      mark: null,
    },
    {
      id: "langroid",
      name: "Langroid",
      summary: "Multi-agent, deliberately small.",
      image: "openbot-harness-langroid",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "community",
      mark: null,
    },
    {
      id: "mastra",
      name: "Mastra",
      summary: "TypeScript agents, with their own server.",
      image: "openbot-harness-mastra",
      health_path: "/health",
      credential: "any-provider",
      maintainer: "partnership",
      mark: "mastra",
    },
    {
      id: "byo-url",
      name: "An agent you already run",
      summary:
        "Give its address. It is proved with a real AG-UI run before it is saved.",
      image: null,
      health_path: null,
      credential: "their-endpoint",
      maintainer: "community",
      mark: null,
    },
  ],
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.",
      logins: ["plan", "api-key"],
      mark: "openai",
      caution: null,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.",
      logins: ["plan", "api-key"],
      mark: "anthropic",
      caution: {
        says: "A Claude plan carries a separate monthly pool of Agent SDK credits. When that pool is empty, Bots stop until it renews or you add API credits.",
        reads_more_at:
          "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan",
      },
    },
    {
      id: "openai-compatible",
      name: "Any OpenAI-compatible endpoint",
      summary:
        "Azure, Bedrock, Mistral, DeepSeek, xAI, Ollama, vLLM or your own.",
      logins: ["endpoint"],
      mark: null,
      caution: null,
    },
  ],
};
// The preview has no Tauri behind it; these are the exact bytes the commands return.
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (cmd: string) =>
    Promise.resolve(CATALOGUES[cmd.replace("plugin:", "")]),
  transformCallback: (cb: unknown) => cb,
};

function Preview() {
  const [harness, setHarness] = useState<string | null>(null);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [screen, setScreen] = useState<"harness" | "provider">("harness");
  return (
    <main>
      {screen === "harness" ? (
        <HarnessPicker
          chosen={harness}
          onChoose={setHarness}
          onContinue={() => setScreen("provider")}
        />
      ) : (
        <ProviderPicker
          chosen={model}
          onChoose={setModel}
          onBack={() => setScreen("harness")}
        />
      )}
    </main>
  );
}
const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<Preview />);
