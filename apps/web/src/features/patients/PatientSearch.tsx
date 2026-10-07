import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import type { PatientSummary } from "@agile-emr/shared";
import { useAuth } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { useApi } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { DataTable, type Col } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, EmptyState, Page, PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/shell/patterns";
import { PatientFlags, PatientLink } from "./PatientBits";

const S = "patients.search";

/** patients.search: find the right patient fast by name, DOB, phone or MRN (fuzzy). */
export function PatientSearchPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [debounced, setDebounced] = React.useState(q.trim());
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q.trim());
      setParams(q.trim() ? { q: q.trim() } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [q, setParams]);

  const results = useApi(
    "searchPatients",
    { query: { q: debounced, limit: 50 } },
    { enabled: debounced.length >= 2 },
  );
  const recent = useApi("listRecentPatients", undefined, { enabled: !debounced });

  const columns = React.useMemo<Col<PatientSummary>[]>(
    () => [
      {
        id: "name",
        header: "Patient",
        accessorFn: (p) => p.name,
        cell: ({ row }) => (
          <span className="grid gap-0.5">
            <PatientLink patient={row.original} testId={tid(S, "res-open")} />
            {row.original.preferredName ? (
              <span className="text-small text-ink-2">"{row.original.preferredName}"</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "dob",
        header: "Date of birth",
        accessorFn: (p) => p.birthDate,
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.birthDate)}</span>
        ),
      },
      {
        id: "mrn",
        header: "MRN",
        accessorFn: (p) => p.mrn,
        cell: ({ row }) => <span className="tabular-nums">{row.original.mrn}</span>,
      },
      {
        id: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) => <span className="tabular-nums">{row.original.phoneMasked ?? "—"}</span>,
      },
      {
        id: "flags",
        header: "",
        enableSorting: false,
        cell: ({ row }) => <PatientFlags flags={row.original.flags} />,
      },
      {
        id: "book",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) =>
          isBuilt("schedule.calendar") && can("bookAppointment") ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid={tid(S, "res-book")}
              onClick={() =>
                navigate(pathTo("schedule.calendar", {}, "book", { patientId: row.original.id }))
              }
            >
              Book
            </Button>
          ) : null,
      },
    ],
    [can, navigate],
  );

  const searching = debounced.length >= 2;
  return (
    <Page>
      <PageHeader
        title="Patients"
        actions={
          can("createPatient") ? (
            <Button
              variant="primary"
              onClick={() =>
                navigate(
                  pathTo("patients.registration", {}, undefined, debounced ? { q: debounced } : {}),
                )
              }
              data-testid={tid(S, "new-patient")}
            >
              <Plus size={18} strokeWidth={1.75} />
              New patient
            </Button>
          ) : null
        }
      />
      <SubNav which="patients" />
      <Card>
        <div className="relative mb-4 max-w-xl">
          <Search
            size={18}
            strokeWidth={1.75}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
            aria-hidden
          />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, DOB, phone or MRN"
            aria-label="Search patients"
            className="pl-10"
            data-testid={tid(S, "search-box")}
          />
        </div>
        {searching ? (
          <DataTable
            columns={columns}
            data={results.data?.data}
            loading={results.isLoading}
            error={results.error}
            onRetry={() => void results.refetch()}
            empty="No patient matches"
            emptyAction={
              can("createPatient") ? (
                <Button
                  onClick={() =>
                    navigate(pathTo("patients.registration", {}, undefined, { q: debounced }))
                  }
                >
                  Register a new patient
                </Button>
              ) : undefined
            }
            getRowId={(p) => p.id}
            testId={tid(S, "results-table")}
          />
        ) : recent.data?.length ? (
          <>
            <CardHeader title="Recently opened" />
            <DataTable
              columns={columns}
              data={recent.data}
              getRowId={(p) => p.id}
              testId={tid(S, "recent-patients")}
            />
          </>
        ) : (
          <EmptyState title="Search for a patient">
            Type at least two characters of a name, a date of birth, a phone number or an MRN.
          </EmptyState>
        )}
      </Card>
    </Page>
  );
}
