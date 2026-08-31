import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type ExportedTemplate,
  exportAgentTemplateMutationOptions,
  updateTemplateDraftMutationOptions,
} from "@/lib/templates/mutations";
import { queryClient } from "@/query-client";

/**
 * Packing a coworker into a file somebody else can read.
 *
 * A DRAFT RATHER THAN A DOWNLOAD, which is the whole reason this is a panel and not a button that
 * saves a file. Two things about a packed coworker are wrong until an author fixes them by hand:
 * the `requests` block is derived from what this Bot happens to have been granted here, which is
 * not the same as what it needs, and `boundary:` is written out at its strictest so that the author
 * widens exactly what the coworker uses rather than exporting a stock deployment's "allow
 * everything" as a requirement. Neither is something the packer can know.
 *
 * WHAT IS NOT IN THE FILE is the interesting half, and the server names every stripped field rather
 * than leaving the absence to be noticed. A person about to hand this to somebody needs to be told
 * that the address, the key and the callback token did not travel — and, for one of the Bots that
 * ship in the box, that its behaviour did not either.
 *
 * PRESSING EXPORT TWICE IS THE THIRD THING, and it used to be a dead end. The draft is unique per
 * author and name, so the second press came back refused — rename one of them — which is not
 * something anybody can do from here: there is no rename control on this panel and the draft being
 * complained about is not shown on it either. The server now answers with that draft instead, edits
 * and all, and hands over the pack it did not apply; re-packing is a button that says what it
 * replaces.
 */
export function ExportTemplate({ agentId }: { agentId: string }) {
  const exportTemplate = useMutation(
    exportAgentTemplateMutationOptions(queryClient),
  );
  const saveDraft = useMutation(
    updateTemplateDraftMutationOptions(queryClient),
  );

  const [draft, setDraft] = useState<ExportedTemplate | null>(null);
  /**
   * The fresh pack the server held back, or null when this draft was written by this press.
   *
   * EXPORTING THE SAME COWORKER TWICE USED TO DEAD-END HERE. The second press was refused with "you
   * already have a template draft called X, rename one of them" — on a panel with no rename control,
   * which does not show the draft in question, and at the one moment somebody is trying to hand
   * their work to somebody else. Now the draft comes back instead, and the pack that was not applied
   * sits in here so the overwrite is a thing a person chooses rather than something that happened
   * to their edits.
   */
  const [repack, setRepack] = useState<string | null>(null);
  /** What is in the box, which is the draft until somebody types in it. */
  const [text, setText] = useState("");
  /** What the server last accepted, so Download is never offered a file nobody has parsed. */
  const [saved, setSaved] = useState("");
  const [copied, setCopied] = useState(false);
  /** Whether the bytes are on screen. The inventory answers the usual question; this answers the rest. */
  const [showFile, setShowFile] = useState(false);

  const dirty = draft !== null && text !== saved;

  if (!draft) {
    return (
      <>
        <Button
          className="w-full text-sm!"
          disabled={exportTemplate.isPending}
          onClick={async () => {
            const packed = await exportTemplate.mutateAsync(agentId);
            setDraft(packed);
            // The stored document, which is the author's version when the draft was already here.
            // Showing the fresh pack instead would put text on screen that the Download button does
            // not serve.
            setText(packed.yaml);
            setSaved(packed.yaml);
            setRepack(packed.repack ?? null);
          }}
          variant="outline"
        >
          {exportTemplate.isPending ? "Exporting…" : "Export template"}
        </Button>
        {/*
         * The packer refuses rather than truncating, so this sentence is usually actionable: a
         * skill slug the format will not admit, prose past a ceiling, or something in the Bot's own
         * text shaped like a key. None of the three is a fault in the export; each is a thing to
         * fix on the coworker.
         */}
        {exportTemplate.error ? (
          <p className="text-destructive text-sm" role="alert">
            {exportTemplate.error.message}
          </p>
        ) : null}
      </>
    );
  }

  const packed = draft.template;

  return (
    <section className="grid gap-3">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Template draft
      </h2>

      {/*
       * SAID PLAINLY, because the alternative is somebody wondering why their edits are back.
       *
       * A person who presses Export twice is not asking for two files. They get the one they already
       * have, and this says so rather than leaving them to notice that the draft is not what the
       * packer would write today. The re-pack is offered right underneath, and it says what it
       * costs: the fresh pack replaces the document, edits included.
       */}
      {repack !== null ? (
        <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-muted-foreground text-xs">
            You had already exported this coworker. This is that draft, with the
            changes you made to it — nothing was packed over them.
          </p>
          <Button
            className="w-full text-sm!"
            disabled={saveDraft.isPending}
            onClick={async () => {
              const next = await saveDraft.mutateAsync({
                templateId: draft.templateId,
                source: repack,
              });
              setText(next.yaml);
              setSaved(next.yaml);
              setRepack(null);
            }}
            variant="outline"
          >
            {saveDraft.isPending ? "Re-packing…" : "Re-pack from the coworker"}
          </Button>
          <p className="text-muted-foreground text-xs">
            Re-packing replaces this draft with the coworker as it is now. What
            you wrote in it goes with it.
          </p>
        </div>
      ) : null}

      <p className="text-muted-foreground text-sm">
        Read it before you send it. Widen the boundary to what this coworker
        actually needs, and cut anything in the requests it does not.
      </p>

      {/*
       * AN INVENTORY BEFORE THE FILE, and the ordering is the change worth stating.
       *
       * This panel used to open with the YAML, which answered "what are the bytes" when the question
       * somebody actually has at this moment is "what did I just hand over". A wall of configuration
       * is a poor answer to that, and it pushed the half that reassures — what did NOT travel —
       * below the fold on a panel nobody scrolled. The file is still here, one press away, because a
       * person about to send this to somebody must be able to read every byte of it.
       */}
      <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
        <p className="font-medium text-xs">What travels</p>
        <ul className="grid gap-1 text-muted-foreground text-xs">
          <li>Its name, its role, and the instructions you wrote for it.</li>
          <li>
            {packed.skills.length === 0
              ? "No skills."
              : `${packed.skills.length === 1 ? "1 skill" : `${packed.skills.length} skills`}: ${packed.skills
                  .map((skill) => skill.slug)
                  .join(", ")}. They become the importer's own.`}
          </li>
          <li>
            {packed.requests.connectors.length === 0
              ? "It asks for no connectors."
              : `It ASKS for ${packed.requests.connectors
                  .map((connector) => connector.id)
                  .join(", ")}. An ask is not a grant.`}
          </li>
          <li>
            A ceiling: shell {packed.boundary.shell}, files{" "}
            {packed.boundary.files}, browser {packed.boundary.browser}, mcp{" "}
            {packed.boundary.mcp}.
          </li>
        </ul>
      </div>

      {draft.stripped.length > 0 ? (
        <div className="grid gap-1 rounded-lg border border-border bg-muted/40 p-3">
          <p className="font-medium text-xs">
            What did not travel ({draft.stripped.length})
          </p>
          <ul className="grid gap-1">
            {draft.stripped.map((line) => (
              <li className="text-muted-foreground text-xs" key={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
       * The file, behind one press rather than gone. Open by default the moment there are unsaved
       * edits, so a person never has to hunt for the box they are being told to save.
       */}
      <Button
        className="w-full text-sm!"
        onClick={() => setShowFile((open) => !open)}
        variant="ghost"
      >
        {showFile || dirty ? "Hide the file" : "Show the file"}
      </Button>

      {showFile || dirty ? (
        <Textarea
          aria-label="Template file"
          className="max-h-[50vh] min-h-48 overflow-y-auto font-mono text-xs"
          onChange={(event) => {
            setCopied(false);
            setText(event.target.value);
          }}
          spellCheck={false}
          value={text}
        />
      ) : null}

      {saveDraft.error ? (
        <p className="text-destructive text-sm" role="alert">
          {saveDraft.error.message}
        </p>
      ) : null}

      {dirty ? (
        <Button
          className="w-full text-sm!"
          disabled={saveDraft.isPending}
          onClick={async () => {
            const next = await saveDraft.mutateAsync({
              templateId: draft.templateId,
              source: text,
            });
            // The server's serialisation, not the text that was posted: the parser is what decides
            // what this file says, and an author should be reading the form it will travel in.
            setText(next.yaml);
            setSaved(next.yaml);
          }}
          variant="outline"
        >
          {saveDraft.isPending ? "Saving…" : "Save changes"}
        </Button>
      ) : null}

      <div className="flex gap-2">
        {/*
         * A link to the file route rather than a Blob built here, so the bytes that are saved are
         * the bytes the server holds and the filename is the one the slug already fixed. It is
         * withheld while there are unsaved edits, because a download that quietly hands over the
         * previous version is worse than one that is not offered.
         */}
        <Button
          className="flex-1 text-sm!"
          disabled={dirty}
          render={
            dirty
              ? undefined
              : (props) => (
                  <a
                    {...props}
                    download
                    href={`/api/templates/${draft.templateId}/file`}
                  />
                )
          }
          variant="outline"
        >
          Download
        </Button>
        <Button
          className="flex-1 text-sm!"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
          variant="outline"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      {dirty ? (
        <p className="-mt-1 text-muted-foreground text-xs">
          Save your changes and the file will be there to download.
        </p>
      ) : null}
    </section>
  );
}
