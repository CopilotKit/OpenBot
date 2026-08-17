type Agent = {
  id: string;
  type: "built_in" | "remote_ag_ui";
  available: boolean;
  reason?: string;
};
type Response = { text: string; citations: unknown[] };

export function createAgentInvoker(ports: {
  knowledge: (question: string) => Promise<Response>;
  remote: (agentId: string, question: string) => Promise<Response>;
}) {
  return async (agent: Agent, question: string) => {
    if (!agent.available)
      throw new Error(agent.reason ?? "Agent is unavailable.");
    return agent.type === "built_in"
      ? ports.knowledge(question)
      : ports.remote(agent.id, question);
  };
}
