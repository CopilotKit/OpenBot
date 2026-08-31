import {
  IconChevronRight,
  IconGitBranch,
  IconPackageImport,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  forgetTemplateSourceMutationOptions,
  registerTemplateSourceMutationOptions,
  retractTemplateImportMutationOptions,
  setTemplateInstallersMutationOptions,
} from "@/lib/templates/mutations";
import {
  type TemplateImportSummary,
  type TemplateSourceRecord,
  templateImportListQueryOptions,
  templateSettingsQueryOptions,
} from "@/lib/templates/queries";
import { queryClient } from "@/query-client";

/**
 * Templates, from the deployment's side: who may install one, where one may be read from, and every
 * coworker that arrived as somebody else's file.
 *
 * THE PAGE IS ABOUT PROVENANCE RATHER THAN ABOUT PERMISSION, and the distinction is load-bearing.
 * Nothing on this screen grants anything: the ledger it renders is a record of what a template
 * ASKED for, and satisfying one of those asks happens on the Bot's own page through the grant
 * screens that already refuse. What an administrator does here is decide who may import at all,
 * decide which repositories may be read from, and take back what an import gave.
 *
 * It sits in "What Bots can reach" because that is the question it answers. An imported coworker is
 * an ordinary coworker — the whole design turns on that — so this is not a second roster; it is the
 * record of where some of the roster came from and what those files wanted.
 */
export const Route = createFileRoute("/_authed/admin/templates")({
  component: TemplatesPage,
});

function TemplatesPage() {
  const settings = useQuery(templateSettingsQueryOptions());
  const imports = useQuery(templateImportListQueryOptions());
  const [problem, setProblem] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [reading, setReading] = useState<TemplateImportSummary | null>(null);

  const setInstallers = useMutation({
    ...setTemplateInstallersMutationOptions(queryClient),
    onError: (thrown: Error) => setProblem(thrown.message),
    onSuccess: () => setProblem(null),
  });
  const forgetSource = useMutation({
    ...forgetTemplateSourceMutationOptions(queryClient),
    onError: (thrown: Error) => setProblem(thrown.message),
    onSuccess: () => setProblem(null),
  });

  /*
   * The stored answer wins over the optimistic one, always. `installers` is a floor an administrator
   * may raise and may not lower, so a switch that trusted its own position would show the setting
   * moved to somewhere the deployment refused to put it.
   */
  const installers =
    setInstallers.data?.installers ?? settings.data?.installers;
  const floored = settings.data?.floor === "admin";

  return (
    <PageShell
      description="Where the coworkers on this deployment came from, when they came from a file somebody wrote. Nothing here grants a capability: what a template asked for is answered on the Bot's own page, through the same screens that decide every other grant."
      title="Templates"
    >
      {problem ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}

      <PageSection
        description="Importing a template creates a coworker, its skills, and nothing else. It is the same write set as creating a Bot by hand, which is why it is open to everybody by default."
        title="Who may install"
      >
        {settings.isPending ? null : settings.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            The template settings could not be read.
          </p>
        ) : (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsers className="size-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Administrators only</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {installers === "admin"
                    ? "Only an administrator may turn a template into a coworker. Anybody may still read one."
                    : "Anybody who may create a coworker may install a template."}
                  {/*
                   * WHY THE SWITCH IS DEAD, said on the row rather than left to be discovered. This
                   * is the `INITIAL_ADMIN_EMAILS` pattern: an environment variable set a floor, the
                   * screen renders it, and no click here can go below it. An administrator who finds
                   * a disabled control with no explanation concludes the screen is broken.
                   */}
                  {floored
                    ? " OPENBOT_TEMPLATE_INSTALLERS set this, so it cannot be relaxed from here."
                    : null}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label="Administrators only"
                  checked={installers === "admin"}
                  disabled={floored || setInstallers.isPending}
                  onCheckedChange={(next) =>
                    setInstallers.mutate(next ? "admin" : "anyone")
                  }
                />
              </ItemActions>
            </Item>
          </PageRows>
        )}
      </PageSection>

      <PageSection
        action={
          settings.data?.allowedSources.length ? (
            <Button
              onClick={() => setRegistering(true)}
              size="sm"
              variant="ghost"
            >
              Register a source
            </Button>
          ) : null
        }
        description="A repository of template files, pinned to one commit and read by this server rather than by anybody's browser. Moving the pin is the only way a source updates, and moving it changes nothing already installed."
        title="Where templates may be read from"
      >
        {settings.isPending || settings.error ? null : settings.data
            ?.allowedSources.length === 0 ? (
          <PageEmpty>
            No repository is permitted. OPENBOT_TEMPLATE_SOURCES ships empty, so
            this deployment reaches no network for templates at all; set it to
            the repositories this deployment may read, and register one here.
          </PageEmpty>
        ) : settings.data?.sources.length === 0 ? (
          <PageEmpty>
            Nothing is registered, so nothing is fetched. Permitted:{" "}
            {settings.data.allowedSources.join(", ")}.
          </PageEmpty>
        ) : (
          <PageRows>
            {settings.data?.sources.map((source, index) => (
              <div key={source.id}>
                <SourceRow
                  busy={forgetSource.isPending}
                  onForget={() => forgetSource.mutate(source.id)}
                  source={source}
                />
                {index < (settings.data?.sources.length ?? 0) - 1 ? (
                  <Separator />
                ) : null}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description="Every coworker here that arrived as a file, with what its template asked for and the ceiling the import applied to it."
        title="Imported coworkers"
      >
        {imports.isPending ? null : imports.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            What this deployment has imported could not be read.
          </p>
        ) : imports.data?.length === 0 ? (
          <PageEmpty>No coworker here came from a template.</PageEmpty>
        ) : (
          <PageRows>
            {imports.data?.map((record, index) => (
              <div key={record.id}>
                <ImportRow onOpen={() => setReading(record)} record={record} />
                {index < (imports.data?.length ?? 0) - 1 ? <Separator /> : null}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <RegisterSourceDialog
        allowed={settings.data?.allowedSources ?? []}
        onClose={() => setRegistering(false)}
        open={registering}
      />
      <ImportDialog onClose={() => setReading(null)} record={reading} />
    </PageShell>
  );
}

/** One registered repository. The pin is the whole of it, and a pin is not a secret. */
function SourceRow({
  source,
  onForget,
  busy,
}: {
  source: TemplateSourceRecord;
  onForget: () => void;
  busy: boolean;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconGitBranch className="size-4" />
      </ItemMedia>
      <ItemContent>
        {/* Plain text, monospace. A repository name is a string somebody typed, not a destination. */}
        <ItemTitle className="break-all font-mono text-sm">
          {source.id}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          Pinned to{" "}
          <span className="break-all font-mono text-xs">{source.sha}</span>.
          Registered by {source.registeredBy} on{" "}
          {new Date(source.registeredAt).toLocaleDateString()}.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button disabled={busy} onClick={onForget} size="sm" variant="ghost">
          <IconTrash className="size-4" />
          Forget
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * One import, summarised by the thing an administrator is actually looking for.
 *
 * The summary states the current ANSWER rather than the field's name — how many asks are still
 * unanswered, and how many clauses are in force — so it changes on its own when a decision is made
 * on the Bot's own page. A chevron and a dialog rather than controls in the row, because a ledger
 * and a list of CEL clauses are not something to edit in place.
 */
function ImportRow({
  record,
  onOpen,
}: {
  record: TemplateImportSummary;
  onOpen: () => void;
}) {
  const unanswered = record.requests.filter(
    (request) => request.status === "requested",
  ).length;

  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        <IconPackageImport className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="break-words">{record.agentName}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {/*
           * "Author claim" rather than "Author", here as everywhere else. Nothing verified it, and a
           * screen that dropped the word on the deployment's own admin page would be the one place
           * the claim looks like a fact.
           */}
          <span className="break-all">
            {record.slug}
            {record.templateVersion ? ` ${record.templateVersion}` : null} ·
            author claim {record.authorClaim ?? "not stated"}
          </span>
        </ItemDescription>
        <ItemDescription className="line-clamp-none">
          {describeSource(record)} · imported by {record.importedBy} on{" "}
          {new Date(record.importedAt).toLocaleDateString()}
        </ItemDescription>
      </ItemContent>
      <ItemFooter className="text-muted-foreground text-xs">
        {record.requests.length === 0
          ? "Asked for nothing."
          : `${record.requests.length} ${record.requests.length === 1 ? "ask" : "asks"}, ${unanswered} unanswered.`}
        {record.boundaries.length > 0
          ? ` ${record.boundaries.length} ${record.boundaries.length === 1 ? "clause" : "clauses"} in force.`
          : " No ceiling applied."}
      </ItemFooter>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/** Where a file came from, in the vocabulary the provenance column actually stores. */
function describeSource(record: TemplateImportSummary): string {
  if (record.source === "gallery") {
    return `From the gallery${record.sourceRef ? ` (${record.sourceRef})` : ""}`;
  }
  return record.source === "file" ? "From a draft here" : "Pasted in";
}

/**
 * One import in full: what it asked for, what it is bounded by, and Retract.
 *
 * READ-ONLY EXCEPT FOR RETRACT, and that is deliberate rather than unfinished. Granting one of these
 * asks happens on the coworker's own page, through the route that reads the live grant tables and
 * refuses an ask this deployment cannot satisfy. A second grant button here would be a second path
 * to a permission with a second set of checks, which is the one thing this feature does not have.
 */
function ImportDialog({
  record,
  onClose,
}: {
  record: TemplateImportSummary | null;
  onClose: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const retract = useMutation({
    ...retractTemplateImportMutationOptions(queryClient),
    onError: (thrown: Error) => setProblem(thrown.message),
    onSuccess: () => {
      setProblem(null);
      onClose();
    },
  });

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
      open={record !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record?.agentName ?? "Import"}</DialogTitle>
          <DialogDescription>
            What this template asked for, and the ceiling the import applied.
            Nothing here is a grant.
          </DialogDescription>
        </DialogHeader>
        {/*
         * `overflow-y-auto` explicitly. `DialogBody` carries `flex-1 min-h-0` and no overflow of its
         * own, and a ledger is exactly the kind of list that outgrows the popup: without it the body
         * shrinks and paints the clauses over the footer.
         */}
        <DialogBody className="mt-4 overflow-y-auto">
          {record ? (
            <div className="grid gap-4">
              <section className="grid gap-2">
                <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  What it asked for
                </h3>
                {record.requests.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    It asked for nothing.
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {record.requests.map((request) => (
                      <li
                        className="rounded-md bg-muted px-3 py-2"
                        key={`${request.kind}:${request.ref}`}
                      >
                        <p className="break-all font-mono text-xs">
                          {request.kind} · {request.ref}
                        </p>
                        {/*
                         * The author's sentence, verbatim and as text. It is a stranger's prose and
                         * it is the whole reason the ledger keeps a `why` column; rendering it as
                         * anything but characters would be rendering markup somebody else wrote.
                         */}
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                          {request.why}
                        </p>
                        <p className="mt-1 text-muted-foreground text-xs">
                          {request.status}
                          {request.decidedBy
                            ? ` by ${request.decidedBy}`
                            : null}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="grid gap-2">
                <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  What it may never do
                </h3>
                {record.boundaries.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    The import applied no ceiling.
                  </p>
                ) : (
                  <ul className="grid gap-1">
                    {record.boundaries.map((clause) => (
                      <li key={clause.expression}>
                        <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                          {clause.expression}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-muted-foreground text-xs">
                  Enforced beside the deployment&rsquo;s own rules, and never in
                  the list an administrator edits on{" "}
                  <Link className="underline" to="/admin/boundaries">
                    Boundaries
                  </Link>
                  .
                </p>
              </section>

              <p className="text-muted-foreground text-xs">
                Retracting takes back the grants this import made and lifts its
                ceiling. The coworker, its skills and this record all stay: it
                is not a delete, and a grant somebody made by hand on the same
                Bot survives.
              </p>
              {problem ? (
                <p className="text-destructive text-sm" role="alert">
                  {problem}
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="ghost">
            Close
          </Button>
          <Button
            disabled={!record || retract.isPending}
            onClick={() => record && retract.mutate(record.agentId)}
            size="sm"
            variant="destructive"
          >
            {retract.isPending ? "Retracting…" : "Retract"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Registering a source: a repository and the commit to pin it to.
 *
 * Two fields, so a dialog rather than two inputs on a row. NEITHER RULE IS RE-DERIVED HERE — the
 * allowlist and the full-sha requirement are decided on the server, and this form sends two strings
 * and renders whatever refusal comes back. A browser-side copy of either would be a second place
 * that decides which repositories this deployment reads from, and it would be the copy that is
 * wrong first.
 */
function RegisterSourceDialog({
  allowed,
  open,
  onClose,
}: {
  allowed: string[];
  open: boolean;
  onClose: () => void;
}) {
  const handleId = useId();
  const shaId = useId();
  const [handle, setHandle] = useState("");
  const [sha, setSha] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const register = useMutation({
    ...registerTemplateSourceMutationOptions(queryClient),
    onError: (thrown: Error) => setProblem(thrown.message),
    onSuccess: () => {
      setProblem(null);
      setHandle("");
      setSha("");
      onClose();
    },
  });

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setProblem(null);
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a source</DialogTitle>
          <DialogDescription>
            A repository this server may read template files from, at one
            commit. Registering the same repository again moves the pin, which
            is the only way a source updates.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4">
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={handleId}>Repository</label>
            <Input
              className="font-mono text-xs"
              id={handleId}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="owner/repo"
              value={handle}
            />
            <span className="text-muted-foreground text-xs">
              Permitted here: {allowed.length ? allowed.join(", ") : "none"}.
              OPENBOT_TEMPLATE_SOURCES decides this and cannot be widened from
              this screen.
            </span>
          </div>
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={shaId}>Commit</label>
            <Input
              className="font-mono text-xs"
              id={shaId}
              onChange={(event) => setSha(event.target.value)}
              placeholder="the full 40-character sha"
              value={sha}
            />
            <span className="text-muted-foreground text-xs">
              A branch name is not accepted. A pin names one immutable tree, so
              what this deployment read yesterday is what it reads today.
            </span>
          </div>
          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={register.isPending || !handle.trim() || !sha.trim()}
            onClick={() =>
              register.mutate({ handle: handle.trim(), sha: sha.trim() })
            }
            size="sm"
          >
            {register.isPending ? "Registering…" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
