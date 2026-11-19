import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { productEngineerKeys, type ProductEngineerRun } from "./queries";

const FALLBACK = "That Product Engineer action could not be completed.";

function invalidateRuns(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: productEngineerKeys.all });
}

export function startProductEngineerRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (ticketId: string) =>
      client<ProductEngineerRun>("/api/product-engineer/runs", "run", {
        method: "POST",
        body: { ticketId },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRuns(queryClient),
  });
}

export function resumeProductEngineerRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: { ticketId: string; feedback: string }) =>
      client<ProductEngineerRun>(
        `/api/product-engineer/runs/${encodeURIComponent(variables.ticketId)}/resume`,
        "run",
        {
          method: "POST",
          body: { feedback: variables.feedback },
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateRuns(queryClient),
  });
}

export function approveProductEngineerRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (ticketId: string) =>
      client<ProductEngineerRun>(
        `/api/product-engineer/runs/${encodeURIComponent(ticketId)}/approve`,
        "run",
        {
          method: "POST",
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateRuns(queryClient),
  });
}

export function approveProductEngineerPlanMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (ticketId: string) =>
      client<ProductEngineerRun>(
        `/api/product-engineer/runs/${encodeURIComponent(ticketId)}/approve-plan`,
        "run",
        {
          method: "POST",
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateRuns(queryClient),
  });
}

export function rejectProductEngineerPlanMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: { ticketId: string; feedback: string }) =>
      client<ProductEngineerRun>(
        `/api/product-engineer/runs/${encodeURIComponent(variables.ticketId)}/reject-plan`,
        "run",
        {
          method: "POST",
          body: { feedback: variables.feedback },
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateRuns(queryClient),
  });
}

export function syncProductEngineerRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (ticketId: string) =>
      client<ProductEngineerRun>(
        `/api/product-engineer/runs/${encodeURIComponent(ticketId)}/sync`,
        "run",
        {
          method: "POST",
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateRuns(queryClient),
  });
}

export function abandonProductEngineerRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (ticketId: string) =>
      client<ProductEngineerRun>(
        `/api/product-engineer/runs/${encodeURIComponent(ticketId)}/abandon`,
        "run",
        {
          method: "POST",
          body: {},
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateRuns(queryClient),
  });
}
