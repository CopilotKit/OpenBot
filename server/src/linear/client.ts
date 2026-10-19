export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  assigneeName: string | null;
  assigneeEmail: string | null;
};

export type LinearViewer = {
  id: string;
  name: string;
  email: string;
};

type GraphqlBody = {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
};

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `Linear API HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as GraphqlBody;
  if (body.errors?.length) {
    throw new Error(
      `Linear GraphQL: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return body.data as T;
}

export async function fetchLinearViewer(
  apiKey: string,
): Promise<LinearViewer> {
  const data = await linearGraphql<{
    viewer: { id: string; name: string; email: string };
  }>(
    apiKey,
    `query Viewer {
      viewer { id name email }
    }`,
  );
  return data.viewer;
}

export async function fetchLinearIssueByIdentifier(
  apiKey: string,
  identifier: string,
): Promise<LinearIssueSummary> {
  const trimmed = identifier.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(trimmed)) {
    throw new Error(
      `Expected a Linear identifier like DES-123, got "${identifier}"`,
    );
  }

  const data = await linearGraphql<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      state: { name: string } | null;
      assignee: { name: string; email: string } | null;
    } | null;
  }>(
    apiKey,
    `query Issue($id: String!) {
      issue(id: $id) {
        id identifier title url
        state { name }
        assignee { name email }
      }
    }`,
    { id: trimmed },
  );

  const issue = data.issue;
  if (!issue) {
    throw new Error(`Linear issue ${trimmed} was not found`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? "unknown",
    assigneeName: issue.assignee?.name ?? null,
    assigneeEmail: issue.assignee?.email ?? null,
  };
}

export async function listLinearIssues(
  apiKey: string,
  options: {
    assigneeEmail?: string;
    assigneeNameContains?: string;
    first?: number;
  } = {},
): Promise<LinearIssueSummary[]> {
  const first = Math.min(Math.max(options.first ?? 30, 1), 100);
  let filter: Record<string, unknown> | undefined;

  if (options.assigneeEmail?.trim()) {
    filter = { assignee: { email: { eq: options.assigneeEmail.trim() } } };
  } else if (options.assigneeNameContains?.trim()) {
    filter = {
      assignee: { name: { containsIgnoreCase: options.assigneeNameContains.trim() } },
    };
  }

  const data = await linearGraphql<{
    issues: {
      nodes: {
        id: string;
        identifier: string;
        title: string;
        url: string;
        state: { name: string } | null;
        assignee: { name: string; email: string } | null;
      }[];
    };
  }>(
    apiKey,
    `query Issues($first: Int!, $filter: IssueFilter) {
      issues(first: $first, filter: $filter, orderBy: updatedAt) {
        nodes {
          id identifier title url
          state { name }
          assignee { name email }
        }
      }
    }`,
    { first, filter: filter ?? null },
  );

  return data.issues.nodes.map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? "unknown",
    assigneeName: issue.assignee?.name ?? null,
    assigneeEmail: issue.assignee?.email ?? null,
  }));
}

export async function createLinearIssue(
  apiKey: string,
  input: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
  },
): Promise<LinearIssueSummary> {
  const data = await linearGraphql<{
    issueCreate: {
      success: boolean;
      issue: {
        id: string;
        identifier: string;
        title: string;
        url: string;
        state: { name: string } | null;
        assignee: { name: string; email: string } | null;
      } | null;
    };
  }>(
    apiKey,
    `mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id identifier title url
          state { name }
          assignee { name email }
        }
      }
    }`,
    {
      input: {
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? "",
        assigneeId: input.assigneeId,
      },
    },
  );

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("Linear did not create the issue.");
  }

  const issue = data.issueCreate.issue;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? "unknown",
    assigneeName: issue.assignee?.name ?? null,
    assigneeEmail: issue.assignee?.email ?? null,
  };
}

export async function assignLinearIssue(
  apiKey: string,
  issueId: string,
  assigneeId: string,
): Promise<LinearIssueSummary> {
  const data = await linearGraphql<{
    issueUpdate: {
      success: boolean;
      issue: {
        id: string;
        identifier: string;
        title: string;
        url: string;
        state: { name: string } | null;
        assignee: { name: string; email: string } | null;
      } | null;
    };
  }>(
    apiKey,
    `mutation Update($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id identifier title url
          state { name }
          assignee { name email }
        }
      }
    }`,
    { id: issueId, input: { assigneeId } },
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error("Linear did not update the issue assignee.");
  }

  const issue = data.issueUpdate.issue;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? "unknown",
    assigneeName: issue.assignee?.name ?? null,
    assigneeEmail: issue.assignee?.email ?? null,
  };
}

export function formatIssueSummary(issue: LinearIssueSummary): string {
  const assignee =
    issue.assigneeName ?? issue.assigneeEmail ?? "Unassigned";
  return `${issue.identifier} — ${issue.title}\nStatus: ${issue.state}\nAssignee: ${assignee}\n${issue.url}`;
}
