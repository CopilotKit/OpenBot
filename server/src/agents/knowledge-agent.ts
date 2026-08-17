type Citation = { title: string; canonicalUrl: string; content: string };

export function createKnowledgeAgent(input: {
  available: boolean;
  search: (question: string) => Promise<Citation[]>;
  complete: (input: {
    question: string;
    context: Citation[];
  }) => Promise<string>;
}) {
  return {
    async respond(question: string) {
      if (!input.available)
        throw new Error("Model credential is not configured.");
      const citations = await input.search(question);
      return {
        text: await input.complete({ question, context: citations }),
        citations,
      };
    },
  };
}
