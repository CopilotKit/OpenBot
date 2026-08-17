import type { ComponentProps } from "react";

/**
 * Shared markdown rendering for Bot prose and tool results.
 *
 * Links open in a new tab with `noreferrer` because content can come from a model or remote MCP
 * server.
 */
export const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentProps<"a">) => (
    <a
      {...rest}
      className="underline underline-offset-2 hover:no-underline"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  ),
};
