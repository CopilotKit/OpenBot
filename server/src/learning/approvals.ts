import { isLearnedSkillName } from "@openbot/shared/learning";

/** The name a proposed skill's SKILL.md gives itself in its front matter, or null when it has none or an unusable one. */
export function skillNameOf(
  files: { path: string; content: string }[],
): string | null {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  const frontMatter = skillFile?.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = frontMatter?.[1]?.match(/^name:[ \t]*(.*?)[ \t]*$/m);
  if (!line) return null;
  const name = (line[1] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();
  return isLearnedSkillName(name) ? name : null;
}
