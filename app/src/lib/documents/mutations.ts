import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { documentKeys, type KnowledgeDocument } from "./queries";

const FALLBACK = "That document could not be saved.";

function invalidateDocuments(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: documentKeys.all });
}

export function createDocumentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { title: string; category: string; body: string }) =>
      client<KnowledgeDocument>("/api/documents", "document", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateDocuments(queryClient),
  });
}

export function updateDocumentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      id: string;
      title: string;
      category: string;
      body: string;
    }) =>
      client<KnowledgeDocument>(
        `/api/documents/${encodeURIComponent(input.id)}`,
        "document",
        {
          method: "PUT",
          body: {
            title: input.title,
            category: input.category,
            body: input.body,
          },
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateDocuments(queryClient),
  });
}

export function deleteDocumentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "That document could not be deleted.",
      }),
    onSuccess: () => invalidateDocuments(queryClient),
  });
}
