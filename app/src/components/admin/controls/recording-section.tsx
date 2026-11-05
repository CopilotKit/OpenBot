import { IconChartBar, IconTerminal2 } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { actionRecordsQueryOptions } from "@/lib/enterprise/queries";
import { ControlsSection } from "./controls-section";

/** Admin, Audit: Action Recording, its recent commands, and the OpenTelemetry export. */
export function RecordingSection() {
  return (
    <ControlsSection
      description="Set OTEL_EXPORTER_OTLP_ENDPOINT to stream audit events and Bot actions to your OpenTelemetry collector or SIEM. They are tagged openbot.surface."
      title="Recording and export"
    >
      {({ data, setSetting, saving }) => (
        <>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconTerminal2 />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Action Recording</ItemTitle>
                <ItemDescription>
                  {data.settings.actionRecording
                    ? `Shell commands Bots run are recorded with secrets removed, and kept ${data.actionRecordRetentionDays} days.`
                    : "Off. Commands show in Audit only."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label="Action Recording"
                  checked={data.settings.actionRecording}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    setSetting("actionRecording", checked)
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconChartBar />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>OpenTelemetry export</ItemTitle>
                <ItemDescription>
                  {data.otel.configured
                    ? "Exporting over OTLP/HTTP."
                    : "Not set up. Set OTEL_EXPORTER_OTLP_ENDPOINT on the server."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-sm">
                  {data.otel.configured ? "On" : "Off"}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
          {data.settings.actionRecording ? <RecordedActions /> : null}
        </>
      )}
    </ControlsSection>
  );
}

function RecordedActions() {
  const actions = useQuery(actionRecordsQueryOptions());
  if (actions.isPending) return null;
  if (actions.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        Couldn't load recorded actions. Reload the page.
      </p>
    );
  if (actions.data.length === 0)
    return <PageEmpty icon={IconTerminal2} title="No commands recorded yet" />;
  return (
    <PageRows>
      {actions.data.map((action, index) => (
        <div key={action.id}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">
                {action.command}
              </ItemTitle>
              <ItemDescription>
                {action.surface === "local"
                  ? "Member's machine"
                  : `Bot ${action.botId ?? "?"}`}{" "}
                · {action.outcome} ·{" "}
                {new Date(action.createdAt).toLocaleString()}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}
