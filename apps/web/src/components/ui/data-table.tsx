import * as React from "react";
import {
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type CellData,
  type ColumnDef,
  type RowData,
  type TableFeatures,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingRows } from "./layout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

/**
 * Pine data table (TanStack Table). Handles the default list states: loading, empty, error (patterns.yaml
 * default_states). Columns set `meta: { numeric: true }` for right-aligned tabular numbers.
 */
declare module "@tanstack/table-core" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<
    in out TFeatures extends TableFeatures,
    in out TData extends RowData,
    TValue extends CellData = CellData,
  > {
    numeric?: boolean;
    className?: string;
  }
}

/** Features every list uses: header-click sorting. Module scope keeps row models stable (v9 rule). */
export const tableFeatureSet = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
});
export type Col<T extends RowData> = ColumnDef<typeof tableFeatureSet, T>;

export function DataTable<T extends RowData>({
  columns,
  data,
  loading,
  error,
  onRetry,
  empty = "Nothing here yet.",
  emptyAction,
  onRowClick,
  selectedId,
  getRowId,
  testId,
  rowTestId,
  compact,
}: {
  columns: Col<T>[];
  data: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: string;
  emptyAction?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  getRowId?: (row: T) => string;
  testId?: string;
  rowTestId?: string;
  compact?: boolean;
}) {
  const rows = React.useMemo(() => data ?? [], [data]);
  const table = useTable({
    features: tableFeatureSet,
    data: rows,
    columns,
    ...(getRowId ? { getRowId: (r: T) => getRowId(r) } : {}),
  });
  if (loading) return <LoadingRows />;
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!data?.length) return <EmptyState title={empty} action={emptyAction} />;
  return (
    <Table data-testid={testId}>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => {
              const sortable =
                h.column.getCanSort() &&
                h.column.columnDef.enableSorting !== false &&
                !!h.column.accessorFn;
              const dir = h.column.getIsSorted();
              return (
                <TableHead
                  key={h.id}
                  numeric={h.column.columnDef.meta?.numeric}
                  className={h.column.columnDef.meta?.className}
                  aria-sort={
                    dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined
                  }
                >
                  {h.isPlaceholder ? null : sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-ink"
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {dir === "asc" ? (
                        <ArrowUp size={14} strokeWidth={1.75} />
                      ) : dir === "desc" ? (
                        <ArrowDown size={14} strokeWidth={1.75} />
                      ) : null}
                    </button>
                  ) : (
                    flexRender(h.column.columnDef.header, h.getContext())
                  )}
                </TableHead>
              );
            })}
          </tr>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            data-testid={rowTestId}
            selected={!!selectedId && row.id === selectedId}
            onClick={onRowClick ? () => onRowClick(row.original) : undefined}
          >
            {row.getAllCells().map((cell) => (
              <TableCell
                key={cell.id}
                compact={compact}
                numeric={cell.column.columnDef.meta?.numeric}
                className={cn(cell.column.columnDef.meta?.className)}
              >
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export type { ColumnDef };
