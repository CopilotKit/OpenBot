export type KnowledgeActor = {
  userId: string;
  groups: string[];
};

export type KnowledgeAclEntry = {
  principal: string;
  effect: "allow" | "deny";
};
