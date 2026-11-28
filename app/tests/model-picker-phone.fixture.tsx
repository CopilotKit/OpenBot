import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ModelPick } from "@/lib/models/effort";
import type { ModelCatalogue } from "@/lib/models/queries";

/**
 * The composer's model picker, as a page of its own for model-picker-phone-layout.test.tsx to
 * bundle and load in a browser: the real picker in the composer's controls row, at its right end
 * where the composer puts it, with a catalogue like a provider's (OpenBot's own model first, taking
 * thinking efforts, and two more).
 */
/*
 * `?thinking=none`: no model takes a thinking effort, so the popup is the models alone, one narrow
 * column, as a team limited to models that don't think sees it.
 */
const thinks = new URLSearchParams(location.search).get("thinking") !== "none";

const catalogue: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "allowed",
  default: "gpt-6.1-terra",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      ...(thinks
        ? { efforts: ["none", "low", "medium", "high", "xhigh", "max"] }
        : {}),
    },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", vendor: "openai" },
    { id: "gpt-4.1", label: "GPT-4.1", vendor: "openai" },
    // A longer name, as a gateway's alias or a dated release reads.
    {
      id: "claude-sonnet-4-5-20250929",
      label: "Claude Sonnet 4.5 (September 2025)",
      vendor: "anthropic",
    },
  ],
};

function Composer() {
  const [pick, setPick] = useState<ModelPick>({
    model: "gpt-6.1-terra",
    effort: null,
  });
  return (
    <div className="flex min-h-svh flex-col justify-end bg-background px-4 pb-24">
      <div
        className="mx-auto w-full max-w-3xl rounded-2xl border bg-card p-3"
        data-slot="composer"
      >
        <div className="h-16 text-muted-foreground text-sm">Ask anything</div>
        <div className="flex items-center justify-end gap-2">
          <ModelPicker catalogue={catalogue} onChange={setPick} value={pick} />
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <Composer />
    </TooltipProvider>,
  );
