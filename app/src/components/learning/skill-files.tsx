import { Streamdown } from "streamdown";
import { markdownComponents } from "@/lib/markdown";

/** SKILL.md without its front matter, whose name and description the screen's header already shows. */
export function skillBody(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** A learned skill's files: SKILL.md rendered, any other file in a collapsible row. A null text is a binary file. */
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
        <section className="grid gap-1.5">
          <h3 className="font-medium text-sm">SKILL.md</h3>
          <div className="rounded-md border p-3">
            <Streamdown
              className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              components={markdownComponents}
              mode="static"
            >
              {skillBody(skill.text)}
            </Streamdown>
          </div>
        </section>
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
