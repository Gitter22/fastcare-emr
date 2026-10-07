import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { OperationId } from "@agile-emr/shared";
import { api, type ApiResponse, type CallArgs } from "./client";

/** Query key for an operation call. Invalidate a whole operation with queryKey: [operationId]. */
export const opKey = <Id extends OperationId>(id: Id, args?: CallArgs<Id>): QueryKey =>
  args ? [id, args] : [id];

/** TanStack Query over a spec operation. */
export function useApi<Id extends OperationId>(
  id: Id,
  args?: CallArgs<Id>,
  options: Omit<
    UseQueryOptions<ApiResponse<Id>, Error, ApiResponse<Id>, QueryKey>,
    "queryKey" | "queryFn"
  > = {},
) {
  return useQuery<ApiResponse<Id>, Error, ApiResponse<Id>, QueryKey>({
    queryKey: opKey(id, args),
    queryFn: ({ signal }) => api(id, { ...(args ?? ({} as CallArgs<Id>)), signal }),
    ...options,
  });
}

/**
 * Mutation over a spec operation. `invalidates` lists operations whose cached reads go stale on success
 * (e.g. arriveAppointment invalidates getFrontDeskBoard).
 */
export function useApiMutation<Id extends OperationId>(
  id: Id,
  options: {
    invalidates?: OperationId[];
    onSuccess?: (data: ApiResponse<Id>, args: CallArgs<Id>) => void;
    onError?: (e: Error) => void;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation<ApiResponse<Id>, Error, CallArgs<Id>>({
    mutationFn: (args) => api(id, args),
    onSuccess: (data, args) => {
      for (const inv of options.invalidates ?? []) void qc.invalidateQueries({ queryKey: [inv] });
      options.onSuccess?.(data, args);
    },
    onError: options.onError,
  });
}

/**
 * Every page of a cursor-paged list operation ({data, nextCursor, hasMore}). For screens that must show the whole
 * range (calendar, day lists); each page uses the API's maximum page size.
 */
export function useApiAll<Id extends OperationId>(
  id: Id,
  args: CallArgs<Id>,
  options: { enabled?: boolean; refetchInterval?: number } = {},
) {
  return useQuery({
    queryKey: [id, args, "all"],
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
    queryFn: async ({ signal }) => {
      type Page = { data: unknown[]; nextCursor?: string | null; hasMore: boolean };
      const all: unknown[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        const a = args as CallArgs<Id> & { query?: Record<string, unknown> };
        const page = (await api(id, {
          ...a,
          query: { ...(a.query ?? {}), limit: 200, ...(cursor ? { cursor } : {}) },
          signal,
        } as CallArgs<Id>)) as unknown as Page;
        all.push(...page.data);
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return all as ApiResponse<Id> extends { data: infer D } ? D : never;
    },
  });
}
