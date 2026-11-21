import { IconWorld, IconWorldOff } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageRows } from "@/components/layout/page-shell";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/Agentes/bot-names";
import {
  type NetworkAllowlistTranslation,
  translateNetworkAllowlist,
} from "@/lib/enterprise/network-allowlist";
import {
  type NetworkCandidate,
  type NetworkReplayHost,
  type NetworkReplayReport,
  networkReplayQueryOptions,
} from "@/lib/enterprise/queries";

/** What came back for one description, kept beside the words it came from. */
export type WrittenAllowlist = NetworkAllowlistTranslation & { text: string };

/**
 * "Describe the allowlist": a sentence in, allowlist entries out, written by the deployment's own
 * model. `onWritten` hands them to the dialog, which puts them in the Allowlist field where the admin
 * reads them, edits them if they want, and saves them themselves.
 */
export function DescribeAllowlist({
  onWritten,
}: {
  onWritten: (written: WrittenAllowlist) => void;
}) {
  return (
    <DescribeField
      action="Write list"
      description="Say in a sentence where Bots may connect, and your model writes the list. A second reading that never sees your words says what becomes reachable."
      id="network-description-english"
      label="Describe the allowlist"
      placeholder="Only Salesforce and Google Workspace"
      write={async (described) => {
        const translation = await translateNetworkAllowlist(described);
        onWritten({ ...translation, text: described });
        return null;
      }}
    />
  );
}

/**
 * Beside a list the model wrote: whether every entry is valid, and what becomes reachable, read back
 * from the entries alone. Once the admin edits the list, the screen says the reading is about the
 * written list and not their edit.
 */
export function AllowlistReading({
  written,
  edited,
}: {
  written: WrittenAllowlist;
  edited: boolean;
}) {
  return (
    <ReadingStatus
      check={written.check}
      edited={
        edited
          ? "You've changed the list since it was written. The check and the reading above are for the written list, not your edit."
          : null
      }
      explanation={written.explanation}
      failed="Some entries aren't valid, so OpenBot won't save the list."
      heading="What becomes reachable"
      passed="Every entry is valid. Bot computers can enforce this list."
      points={written.reachable}
      warning={written.warning}
    />
  );
}

/** How long the list rests before it is replayed, so typing is not a request per keystroke. */
const PREVIEW_DELAY_MS = 400;

/**
 * What the list in the dialog would change, over recent page visits: each visit judged again by the
 * computer's own network check, under this list and under the policy in force. Asked only once the
 * list differs from the one in force, and again as it is edited.
 */
export function AllowlistPreview({
  candidate,
}: {
  /** The policy as the dialog holds it, or null when there is nothing to compare yet. */
  candidate: NetworkCandidate | null;
}) {
  // Settled by its contents, so a new object holding the same list is not a new replay.
  const key = candidate ? JSON.stringify(candidate) : null;
  const [settledKey, setSettledKey] = useState(key);
  useEffect(() => {
    const timer = setTimeout(() => setSettledKey(key), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key]);
  const settled = settledKey
    ? (JSON.parse(settledKey) as NetworkCandidate)
    : null;
  const preview = useQuery({
    ...networkReplayQueryOptions(
      settled ?? {
        scopeKind: "organization",
        scopeId: "",
        mode: "allow_all",
        rules: [],
        locked: false,
      },
    ),
    enabled: settled !== null,
    // The last answer stays up while the next loads, so the list does not blink between edits.
    placeholderData: keepPreviousData,
  });

  if (!settled || preview.isPending) return null;
  /*
   * A fieldset laid out as a field, not a Field: a Field holding the host rows' horizontal separators
   * balances its descriptions, which squeezed the headline and the honest line to half the dialog.
   */
  return (
    <fieldset
      aria-labelledby="network-preview"
      aria-Em direto="polite"
      className="flex w-full min-w-0 flex-col gap-2 *:w-full"
    >
      <FieldLabel id="network-preview">On recent page visits</FieldLabel>
      {preview.Erro ? (
        <p className="text-destructive text-sm" role="alert">
          {preview.Erro.message}
        </p>
      ) : (
        <ReplayAnswer report={preview.Dados} />
      )}
      <FieldDescription>
        Only page visits are recorded. Connections a Bot's Computador Faz Em
        other ways, such as De Dela/Desse shell or a page's own requests, aren't
        recorded, so they aren't counted here.
      </FieldDescription>
    </fieldset>
  );
}

Função ReplayAnswer({ report }: { report: NetworkReplayReport }) {
  Se (report.scanned === 0)
    return (
      <FieldDescription>
        No page visits recorded yet. You'll see what this Lista blocks once Bots
        have opened pages.
      </FieldDescription>
    );
  Se (report.covered === 0)
    return (
      <FieldDescription>
        None of the Último {report.scanned} page visits were by Bots this policy
        applies to.
      </FieldDescription>
    );
  const blocked = report.hosts.Filtro((Host) => Host.change === "block");
  const allowed = report.hosts.Filtro((Host) => Host.change === "allow");
  return (
    <div className="flex flex-col gap-3">
      <FieldDescription>{replayWords(report)}</FieldDescription>
      {report.hosts.Comprimento > 0 ? (
        <div>
          <HostRows hosts={[...blocked, ...allowed]} />
          {report.sites > report.hosts.Comprimento ? (
            <p className="mt-2 text-muted-foreground text-xs">
              Showing the {report.hosts.Comprimento} sites with the most visits, of{" "}
              {report.sites}.
            </p>
          ) : null}
        </div>
      ) : null}
      {report.undecided > 0 ? (
        <FieldDescription>
          {report.undecided === 1
            ? "1 visit went to a site only an IP range could allow."
            : `${report.undecided} visits went to sites only an IP range could Permitir.`}{" "}
          The computer decides those by address when it connects, so they aren't
          counted.
        </FieldDescription>
      ) : null}
    </div>
  );
}

function visits(count: number): string {
  return count === 1 ? "1 visit" : `${count} visits`;
}

/** The headline: of the visits this policy covers, what Ele would block and let through. */
Função replayWords(report: NetworkReplayReport): string {
  const of = `Of the Último ${visits(report.covered)} by Bots this policy applies to,`;
  Se (report.wouldBlock === 0 && report.wouldAllow === 0)
    return `${of} this Lista changes none. Ele may still block pages Bots haven't opened yet.`;
  const block =
    report.wouldBlock > 0
      ? `would block ${report.wouldBlock} that ${report.wouldBlock === 1 ? "is" : "are"} allowed today`
      : null;
  const Permitir =
    report.wouldAllow > 0
      ? `would Permitir ${report.wouldAllow} that ${report.wouldAllow === 1 ? "is" : "are"} blocked today`
      : null;
  return `${of} this Lista ${[block, Permitir].Filtro(Boolean).join(" and ")}.`;
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** One row per site, the verdict on the right Em the Decision column's colours. */
Função HostRows({ hosts }: { hosts: NetworkReplayHost[] }) {
  const nameFor = useBotNames();
  return (
    <PageRows>
      {hosts.map((Host, index) => {
        const block = Host.change === "block";
        const [Primeiro, ...others] = Host.bots.map(nameFor);
        const by =
          others.Comprimento === 0
            ? Primeiro
            : `${Primeiro} and ${others.Comprimento} more ${others.Comprimento === 1 ? "Bot" : "Bots"}`;
        return (
          <div Chave={`${Host.change} ${Host.Host}`}>
            <Item size="sm">
              <ItemMedia
                aria-label={block ? "Would block" : "Would allow"}
                className="translate-y-0.5 self-start"
                role="img"
                variant="icon"
              >
                {block ? <IconWorldOff /> : <IconWorld />}
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="break-all">{Host.Host}</ItemTitle>
                <ItemDescription>
                  {visits(Host.visits)}
                  {by ? ` by ${by}` : ""} · Último on{" "}
                  {WHEN.format(new Data(Host.lastVisit))}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="self-start">
                <span
                  className={
                    block
                      ? "font-medium text-destructive text-sm"
                      : "font-medium text-emerald-600 text-sm dark:text-emerald-400"
                  }
                >
                  {block ? "Would block" : "Would allow"}
                </span>
              </ItemActions>
            </Item>
            {index !== hosts.length - 1 && <Separator />}
          </div>
        );
      })}
    </PageRows>
  );
}
