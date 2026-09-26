import { IconShieldCog } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { RowMark } from "@/components/layout/row-mark";

/**
 * Per-bot approval levels. Every Bot runs at one of three levels; the gate on
 * the server decides allow-or-ask before a tool call goes out, so this page is
 * only the reading and writing of that setting, never the decision itself.
 */
export const Route = createFileRoute("/_authed/admin/approval-levels")({
  component: ApprovalLevelsPage,
});

type Level = "autonomous" | "confirm-risky" | "confirm-all";

type ApprovalRow = {
  agentId: string;
  name: string;
  approvalLevel: Level;
  riskyPatterns: string[];
};

const LEVELS: Array<{ value: Level; label: string }> = [
  { value: "autonomous", label: "Autonomous" },
  { value: "confirm-risky", label: "Confirm risky" },
  { value: "confirm-all", label: "Confirm everything" },
];

const LEVEL_HELP: Record<Level, string> = {
  autonomous: "Runs tools without asking.",
  "confirm-risky": "Asks before actions matching the risky patterns.",
  "confirm-all": "Asks before every tool call.",
};

function ApprovalLevelsPage() {
  const queryClient = useQueryClient();
  const levels = useQuery({
    queryKey: ["approval-levels"],
    queryFn: () =>
      client<{ agents: ApprovalRow[] }>("/api/plugins/approval-levels", "approval levels"),
  });
  const save = useMutation({
    mutationFn: (input: { agentId: string; approvalLevel: Level; riskyPatterns: string[] }) =>
      client("/api/plugins/approval-levels", "approval levels", {
        method: "POST",
        body: input,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["approval-levels"] }),
  });

  const rows = levels.data?.agents ?? [];

  return (
    <PageShell
      title="Approval levels"
      description="How much each Bot may do before it has to ask."
    >
      <PageSection title="Bots">
        {rows.length === 0 ? (
          <PageEmpty>
            <IconShieldCog />
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((row) => (
              <ApprovalItem key={row.agentId} row={row} save={save} />
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

function ApprovalItem({
  row,
  save,
}: {
  row: ApprovalRow;
  save: {
    mutate: (input: {
      agentId: string;
      approvalLevel: Level;
      riskyPatterns: string[];
    }) => void;
  };
}) {
  const [level, setLevel] = React.useState<Level>(row.approvalLevel);
  const [patterns, setPatterns] = React.useState(row.riskyPatterns.join(", "));
  const dirty =
    level !== row.approvalLevel || patterns !== row.riskyPatterns.join(", ");

  return (
    <Item>
      <RowMark />
      <ItemContent>
        <ItemTitle>{row.name}</ItemTitle>
        <ItemDescription>{LEVEL_HELP[level]}</ItemDescription>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {LEVELS.map((option) => (
            <Button
              key={option.value}
              variant={level === option.value ? "default" : "outline"}
              size="sm"
              onClick={() => setLevel(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {level === "confirm-risky" && (
          <Input
            className="mt-2"
            value={patterns}
            onChange={(event) => setPatterns(event.target.value)}
            placeholder="Risky patterns, comma separated"
          />
        )}
        {dirty && (
          <Button
            className="mt-2"
            size="sm"
            onClick={() =>
              save.mutate({
                agentId: row.agentId,
                approvalLevel: level,
                riskyPatterns: patterns
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean),
              })
            }
          >
            Save
          </Button>
        )}
      </ItemContent>
    </Item>
  );
}
