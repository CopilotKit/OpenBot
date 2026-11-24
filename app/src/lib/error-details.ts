/**
 * An error the app couldn't handle, written out for a person to paste into a bug report: what
 * failed, where, on which release and build, in which browser or app. Shown under the route's error
 * screen and copied by its Copy details (`components/layout/route-error.tsx`).
 *
 * Only what the page itself knows. The address is its path, without the query, which can carry a
 * sign-in's code. No keys, tokens or messages are in reach of it.
 */

declare const __OPENBOT_APP_VERSION__: string | undefined;

/** The release this build was made for, from the image's OPENBOT_BUILD_VERSION, when it was given one. */
export function appVersion(): string | undefined {
  const version =
    typeof __OPENBOT_APP_VERSION__ === "string"
      ? __OPENBOT_APP_VERSION__
      : undefined;
  return version &&
    /^v?\d+(?:\.\d+){1,3}(?:-[a-z]+(?:\.\d{1,9})?)?$/.test(version)
    ? version
    : undefined;
}

/** The error's own line: its kind and its message, as a stack's first line says it. */
export function errorLine(error: unknown): string {
  if (error instanceof Error)
    return `${error.name || "Error"}: ${error.message}`.trim();
  if (typeof error === "string") return error;
  return `A ${typeof error} was thrown`;
}

/** At most this many of the stack's lines, which is where it failed and how it got there. */
const STACK_LINES = 8;

export type ErrorContext = {
  /** The page's path when it failed. */
  path: string;
  /** The build the page is, by its entry script's file name. */
  build: string | null;
  /** OpenBot Desktop around the page, as it names itself, or null in a browser. */
  desktop: string | null;
  userAgent: string;
  at: Date;
};

/** The report, as plain text. */
export function errorDetails(error: unknown, context: ErrorContext): string {
  const version = appVersion();
  const stack =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && line !== errorLine(error))
          .slice(0, STACK_LINES)
      : [];
  return [
    errorLine(error),
    `Page: ${context.path}`,
    `OpenBot: ${version ?? "version not known"}${context.build ? ` (${context.build})` : ""}`,
    ...(context.desktop ? [`App: ${context.desktop}`] : []),
    `Browser: ${context.userAgent}`,
    `When: ${context.at.toISOString()}`,
    ...(stack.length ? ["", ...stack] : []),
  ].join("\n");
}
