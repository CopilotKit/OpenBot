import { useId, useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * A project name typed where the project will be drawn.
 *
 * Inline rather than in a dialog: the Projects section is where the new folder appears, so the box
 * that names it sits in the same place, and Enter creates it without the person having to find a
 * Save button. Escape, or clicking away, leaves nothing behind.
 *
 * The same box renames an existing folder — one component, because it is one interaction, and a
 * name is the only thing a project has to edit.
 */
export function ProjectNameInput({
  initialName = "",
  placeholder,
  submitLabel,
  pending,
  problem,
  onSubmit,
  onCancel,
}: {
  initialName?: string;
  placeholder: string;
  /** Said on the submit button's screen-reader label, so the two uses of this box stay distinct. */
  submitLabel: string;
  pending: boolean;
  /** What the server said when the last attempt failed, if it did. */
  problem?: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(initialName);
  const submit = () => {
    const name = draft.replace(/\s+/g, " ").trim();
    if (name.length === 0) {
      onCancel();
      return;
    }
    onSubmit(name);
  };

  return (
    <form
      className="px-2.5 pb-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) submit();
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        {submitLabel}
      </label>
      <Input
        autoComplete="off"
        autoFocus
        className="h-7 text-sm"
        disabled={pending}
        id={inputId}
        maxLength={60}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        value={draft}
      />
      {problem ? (
        <p className="mt-1 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
      {/* Kept out of the tab order on purpose: Enter and Escape are the whole interaction, and a
          visible pair of buttons in a 28px row would be wider than the row is tall. */}
      <button className="sr-only" disabled={pending} type="submit">
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}