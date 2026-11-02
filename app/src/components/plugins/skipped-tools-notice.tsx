/**
 * The actions an app's last refresh left out because no model could be offered their names.
 *
 * A WARNING, NOT AN ERROR. The refresh stored every other action, so the app works; what is missing
 * is named here, on the app's own page, so nobody has to notice the gap for themselves. It used to
 * ride in `lastError`, which was drawn only when the app had no tools at all and turned the app's
 * row on the Plugins list red — for good, for a server that keeps listing the name.
 */
export function SkippedToolsNotice({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <p
      className="mt-4 text-amber-600 text-sm dark:text-amber-500"
      role="status"
    >
      {names.length === 1
        ? "One action this app lists was left out, because a tool name may only use letters, digits, underscores and hyphens: "
        : `${names.length} actions this app lists were left out, because a tool name may only use letters, digits, underscores and hyphens: `}
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 ? ", " : null}
          <code className="font-mono text-xs">{name}</code>
        </span>
      ))}
      .
    </p>
  );
}
