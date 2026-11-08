import { Streamdown } from "streamdown";
import { readableSkillBody } from "@/lib/learning/display";
import { markdownComponents } from "@/lib/markdown";

/**
 * A learned skill's files: SKILL.md rendered as the skill's own content, with no file name over it, and any other file
 * in a collapsible row. A null text is a binary file. What is rendered is the readable body (`readableSkillBody`); the
 * text a Bot loads is not changed.
 */
export function SkillFiles({
  files,
}: {
  files: { path: string; text: string | null }[];
}) {
  const skill = files.find((file) => file.path === "SKILL.md");
  // A SKILL.md that is binary has no text to render, so it is listed like any other binary file.
  const others = files.filter(
    (file) => file.path !== "SKILL.md" || file.text === null,
  );
  return (
    <>
      {skill?.text != null && (
        <Streamdown
          className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          components={markdownComponents}
          mode="static"
        >
          {readableSkillBody(skill.text)}
        </Streamdown>
      )}
      {others.length > 0 && (
        <section className="grid gap-1.5">
          <h3 className="font-medium text-sm">Other files</h3>
          {others.map((file) =>
            file.text === null ? (
              <div className="rounded-md border p-3 text-sm" key={file.path}>
                {file.path}
              </div>
            ) : (
              <details
                className="rounded-md border p-3 text-sm"
                key={file.path}
              >
                <summary className="cursor-pointer">{file.path}</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">
                  {file.text}
                </pre>
              </details>
            ),
          )}
        </section>
      )}
    </>
  );
}
