export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  /** Human-approved plan, when coding was gated on approval. */
  plan?: string | null;
};

/**
 * Fetch a Linear issue by human identifier (e.g. DES-123).
 * Orchestrator-owned fetch is more deterministic than relying on the agent MCP for intake.
 */
export async function fetchLinearIssue(
  apiKey: string,
  identifier: string,
): Promise<LinearIssue> {
  const trimmed = identifier.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(trimmed)) {
    throw new Error(
      `Expected a Linear identifier like DES-123, got "${identifier}"`,
    );
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          state { name }
        }
      }`,
      variables: { id: trimmed },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Linear API HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    data?: {
      issue?: {
        id: string;
        identifier: string;
        title: string;
        description: string | null;
        url: string;
        state: { name: string } | null;
      } | null;
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `Linear GraphQL: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const issue = body.data?.issue;
  if (!issue) {
    throw new Error(`Linear issue ${trimmed} was not found`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    url: issue.url,
    state: issue.state?.name ?? "unknown",
  };
}
