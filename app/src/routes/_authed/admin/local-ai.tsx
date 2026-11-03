import { IconCpu, IconRefresh, IconWorld } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { client } from "@/lib/client";

export const Route = createFileRoute("/_authed/admin/local-ai")({
  component: LocalAiPage,
});

type LocalAiReport = {
  runtimes: {
    name: string;
    baseUrl: string;
    models: { id: string; sizeBytes: number | null }[];
  }[];
  inUse: { baseUrl: string | null; model: string | null; isLocal: boolean };
};

function size(bytes: number | null) {
  if (!bytes) return null;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The AI already on this computer, as Cindy's "Detected on this computer" shows it: Ollama and LM
 * Studio, each model they have, and which one OpenBot is using now. Switching is one command, because
 * the model is a server setting read when OpenBot starts.
 */
function LocalAiPage() {
  const report = useQuery({
    queryKey: ["admin", "local-ai"],
    queryFn: () =>
      client("/api/admin/local-ai", {
        fallback: "Couldn't look for AI on this computer.",
      }).then((response) => response.json() as Promise<LocalAiReport>),
  });
  const data = report.data;
  const inUse = data?.inUse;

  return (
    <PageShell
      action={
        <Button
          disabled={report.isFetching}
          onClick={() => void report.refetch()}
          variant="outline"
        >
          <IconRefresh />
          Look again
        </Button>
      }
      description="Use online AI, or the AI on this computer so your Bots work free and without the internet."
      title="AI: online or offline"
    >
      <PageSection
        description="Pick one. Switching is one command, then restart OpenBot."
        title="Online or offline"
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia>
              <IconWorld />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Online</ItemTitle>
              <ItemDescription>
                {inUse && !inUse.isLocal
                  ? `In use now: ${inUse.model ?? "the default model"}${inUse.baseUrl ? ` at ${inUse.baseUrl}` : ", through OpenAI"}`
                  : "OpenAI or your own AI server. To use it: bun run ai online"}
              </ItemDescription>
            </ItemContent>
            {inUse && !inUse.isLocal ? (
              <ItemActions>
                <span className="font-medium text-primary text-xs">On</span>
              </ItemActions>
            ) : null}
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia>
              <IconCpu />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Offline, on this computer</ItemTitle>
              <ItemDescription>
                {inUse?.isLocal
                  ? `In use now: ${inUse.model ?? "a local model"} at ${inUse.baseUrl}`
                  : "Free and private, no internet needed. To use it: bun run ai offline"}
              </ItemDescription>
            </ItemContent>
            {inUse?.isLocal ? (
              <ItemActions>
                <span className="font-medium text-primary text-xs">On</span>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
      </PageSection>

      {report.isPending ? null : report.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {report.error.message}
        </p>
      ) : data?.runtimes.length ? (
        data.runtimes.map((runtime) => (
          <PageSection
            description={`Found at ${runtime.baseUrl}`}
            key={runtime.baseUrl}
            title={`Found: ${runtime.name}`}
          >
            <PageRows>
              {runtime.models.length === 0 ? (
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>No models yet</ItemTitle>
                    <ItemDescription>
                      Download one in {runtime.name}, then look again.
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ) : (
                runtime.models.map((model, index) => (
                  <Fragment key={model.id}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>{model.id}</ItemTitle>
                        <ItemDescription>
                          {inUse?.model === model.id && inUse.isLocal
                            ? "In use now"
                            : `To use it: bun run ai offline ${model.id}, then restart OpenBot`}
                        </ItemDescription>
                      </ItemContent>
                      {size(model.sizeBytes) ? (
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {size(model.sizeBytes)}
                          </span>
                        </ItemActions>
                      ) : null}
                    </Item>
                  </Fragment>
                ))
              )}
            </PageRows>
          </PageSection>
        ))
      ) : (
        <PageSection title="Found">
          <PageEmpty icon={IconCpu} title="No AI found on this computer">
            Install Ollama (ollama.com) or LM Studio, download a model, then
            press Look again. For an RTX 3060, an 8B model such as qwen3:8b or
            llama3.1:8b runs well.
          </PageEmpty>
        </PageSection>
      )}
    </PageShell>
  );
}
