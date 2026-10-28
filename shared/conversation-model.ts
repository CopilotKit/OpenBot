export type SavedModelSelection = {
  agentId: string;
  provider: "openai" | "anthropic";
  model: string;
};
export type ConversationModel = {
  selectable: boolean;
  provider: "openai" | "anthropic" | null;
  defaultModel: string | null;
  selectedModel: string | null;
  options: { id: string; label: string }[];
  selectionUnavailable: boolean;
};
