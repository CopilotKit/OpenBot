import type { ReactNode } from "react";

/**
 * One line saying something is under way, with who is doing it.
 *
 * For a wait the person did not start and cannot watch: a Bot asked by their Bot, a routine firing,
 * a sign-in or an approval somebody else has to finish. Drawn where the result will appear, so the
 * person looks at the right spot.
 *
 * It borrows the shimmer a running tool line uses, so every kind of "working on it" in the
 * transcript reads the same.
 */
export function ProgressRow({
  label,
  media,
}: {
  /** What is under way, as a person would say it: "Asking Ana…". */
  label: string;
  /** Who is doing it, drawn before the words: a Bot's avatar. */
  media?: ReactNode;
}) {
  return (
    <p
      className="flex items-center gap-2 text-muted-foreground text-sm"
      data-testid="progress-row"
      // `status` rather than `alert`: progress, not an interruption.
      role="status"
    >
      {media ? <span aria-hidden="true">{media}</span> : null}
      <span className="tool-line-running">{label}</span>
    </p>
  );
}
