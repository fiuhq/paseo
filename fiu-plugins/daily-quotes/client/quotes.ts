import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { listQuotes } from "../shared/contracts";
import { dayNumber, type QuotesState } from "../shared/quotes";

/** One cache per installation, so the title and the settings screen read the same list. */
const QUOTES_KEY = ["daily-quotes", "list"] as const;

export function useQuotes() {
  const list = useRpc(listQuotes);
  return useQuery({ queryKey: QUOTES_KEY, queryFn: () => list({}), retry: false });
}

/** Writes a change's answer into the cache, so every placement on this client shows it at once. */
export function useStoreQuotes(): (state: QuotesState) => void {
  const queryClient = useQueryClient();
  return useCallback((state) => queryClient.setQueryData(QUOTES_KEY, state), [queryClient]);
}

/** Refetches the host's list, so a screen a refused change found stale catches up. */
export function useRefetchQuotes(): () => void {
  const queryClient = useQueryClient();
  return useCallback(
    () => void queryClient.invalidateQueries({ queryKey: QUOTES_KEY }),
    [queryClient],
  );
}

/** Today on this device's calendar. */
export function today(): number {
  return dayNumber(new Date());
}
