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
 */
export function ExportTemplate({ agentId }: { agentId: string }) {
  const exportTemplate = useMutation(
    exportAgentTemplateMutationOptions(queryClient),
  );
  const saveDraft = useMutation(
    updateTemplateDraftMutationOptions(queryClient),
  );

  const [draft, setDraft] = useState<ExportedTemplate | null>(null);
  /** What is in the box, which is the draft until somebody types in it. */
  const [text, setText] = useState("");
  /** What the server last accepted, so Download is never offered a file nobody has parsed. */
  const [saved, setSaved] = useState("");
  const [copied, setCopied] = useState(false);

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
            setText(packed.yaml);
            setSaved(packed.yaml);
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

  return (
    <section className="grid gap-2">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Template draft
      </h2>

      <p className="text-muted-foreground text-sm">
        Read it before you send it. Widen the boundary to what this coworker
        actually needs, and cut anything in the requests it does not.
      </p>

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

      {draft.stripped.length > 0 ? (
        <div className="grid gap-1 rounded-lg border border-border bg-muted/40 p-3">
          <p className="font-medium text-xs">What did not travel</p>
          <ul className="grid gap-1">
            {draft.stripped.map((line) => (
              <li className="text-muted-foreground text-xs" key={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
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
