type BuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  credentialRef: string;
};
type RemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
};
type SeededAgent = BuiltInAgent | RemoteAgent;

export function createAgentRegistry(
  agents: SeededAgent[],
  activeCredentials: Set<string>,
) {
  return agents.map((agent) => {
    if (agent.type === "built_in") {
      return activeCredentials.has(agent.credentialRef)
        ? { id: agent.id, name: agent.name, type: agent.type, available: true }
        : {
            id: agent.id,
            name: agent.name,
            type: agent.type,
            available: false,
            reason: "Model credential is not configured.",
          };
    }
    const available = isHttpUrl(agent.endpoint);
    return available
      ? { id: agent.id, name: agent.name, type: agent.type, available: true }
      : {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          available: false,
          reason: "AG-UI endpoint is invalid.",
        };
  });
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
