/**
 * Standing instructions for the Product Engineer cloud agent.
 * Kept in the orchestrator, not only as a chat persona — every start/resume
 * run gets the same policy.
 */
export const PRODUCT_ENGINEER_SYSTEM_PROMPT = `You are Descasio's Product Engineer.

You implement Linear tickets in the repositories you have been granted. You are a coding worker, not a product manager and not a merge bot.

## Hard rules

1. Work only in the repositories attached to this agent. Do not invent APIs, files, tickets, or acceptance criteria that are not in the issue or the codebase.
2. Run the project's real test command(s) before you open or update a pull request. If tests cannot run in this environment, say so plainly in the PR and do not claim they passed.
3. Every pull request must:
   - Link the Linear issue identifier (for example DES-123) in the title or body.
   - Include a section titled "How a human can test this" with concrete steps (commands, URLs, expected results).
   - Summarise what changed and which acceptance criteria you believe are met.
4. Never merge. Never force-push to the default branch. Never delete protected branches.
5. Prefer a single focused PR per ticket. If the ticket truly spans frontend and backend, keep changes coherent and document how both sides are tested.
6. When you receive review feedback, fix the named issues, re-run tests, and update the same PR. Do not open a duplicate PR for the same ticket unless the previous branch is gone.

## What done looks like

A pull request URL, green or honestly reported local tests, and a human test plan. Stop there and wait for human approval.`;

/**
 * Cloud agents do not apply `systemPrompt` yet (SDK warning). Standing policy is
 * therefore prepended to every user message so implement and resume stay governed.
 */
function withStandingPolicy(body: string): string {
  return `${PRODUCT_ENGINEER_SYSTEM_PROMPT}\n\n---\n\n${body}`;
}

export function buildImplementPrompt(issue: {
  identifier: string;
  title: string;
  description: string;
  url: string;
  /** Human-approved plan; when present, follow it. */
  plan?: string | null;
}): string {
  const plan = issue.plan?.trim();
  return withStandingPolicy(
    [
      `Implement Linear ticket ${issue.identifier}.`,
      "",
      `Title: ${issue.title}`,
      `URL: ${issue.url}`,
      "",
      plan
        ? ["Approved implementation plan (follow this):", plan, ""].join("\n")
        : "",
      "Description / acceptance criteria:",
      issue.description.trim() || "(no description provided)",
      "",
      "Tasks:",
      "1. Explore the granted repositories and locate the code this ticket needs.",
      "2. Implement the change.",
      "3. Run the project's real tests.",
      '4. Open a pull request (do not merge) that links this Linear id and includes "How a human can test this".',
      "5. Reply with the PR URL and a short summary of what you changed.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
}

export function buildResumePrompt(
  feedback: string,
  issueIdentifier?: string,
): string {
  const ticket = issueIdentifier ? ` for ${issueIdentifier}` : "";
  return withStandingPolicy(
    [
      `Human / QA review feedback${ticket}. Update the existing pull request; do not merge.`,
      "",
      feedback.trim(),
      "",
      "Tasks:",
      "1. Address each point above.",
      "2. Re-run the project's real tests.",
      "3. Push updates to the same PR.",
      "4. Reply with the PR URL and what you changed.",
    ].join("\n"),
  );
}

/** Read-only QA pass (v2). Separate agent; does not push. */
export function buildQaPrompt(issue: {
  identifier: string;
  title: string;
  description: string;
  prUrl?: string;
}): string {
  return [
    `Review the implementation of Linear ticket ${issue.identifier} against its acceptance criteria.`,
    "",
    `Title: ${issue.title}`,
    issue.prUrl
      ? `PR: ${issue.prUrl}`
      : "PR: (find the open PR for this ticket)",
    "",
    "Acceptance criteria / description:",
    issue.description.trim() || "(none)",
    "",
    "Rules:",
    "- Read the diff and related code only. Do not push, merge, or edit files.",
    "- List concrete failures or gaps. If everything looks met, say so and list remaining human test steps.",
  ].join("\n");
}

/**
 * Draft a plan from the Linear issue for human approval before Cursor coding.
 * Deterministic (no model call): enough for a gate, cheap enough to regenerate on reject.
 */
export function buildPlanFromIssue(
  issue: {
    identifier: string;
    title: string;
    description: string;
    url: string;
  },
  options?: { repos?: readonly string[]; feedback?: string },
): string {
  const description = issue.description.trim() || "(no description provided)";
  const repos =
    options?.repos && options.repos.length > 0
      ? options.repos.map((url) => `- ${url}`).join("\n")
      : "- (repos from PE_REPOS at run time)";
  const feedback = options?.feedback?.trim();

  return [
    `# Plan for ${issue.identifier}`,
    "",
    `**Title:** ${issue.title}`,
    `**Linear:** ${issue.url}`,
    "",
    "## Goal",
    description,
    "",
    "## Repositories",
    repos,
    "",
    "## Proposed approach",
    "1. Explore the granted repositories for the code this ticket needs.",
    "2. Implement only what the ticket asks for — no invented APIs or acceptance criteria.",
    "3. Run the project's real tests before opening or updating a PR.",
    "4. Open a single focused PR (do not merge) that links this Linear id and includes how a human can test it.",
    "",
    "## Out of scope",
    "- Merging the PR",
    "- Work outside the attached repositories",
    feedback ? ["", "## Revision notes from human", feedback].join("\n") : "",
    "",
    "## After approval",
    "Cursor cloud coding starts only once a human approves this plan in AgentForce.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
