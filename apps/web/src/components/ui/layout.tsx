import * as React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronRight, Lock, OctagonAlert, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/** Card: white island on canvas, no border/shadow, never nested (Pine rule 5). */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("min-w-0 bg-surface p-6", className)} {...props} />;
}

export function CardHeader({
  title,
  actions,
  className,
  titleId,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-4", className)}>
      <h3 id={titleId} className="text-h3 text-ink">
        {title}
      </h3>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface Crumb {
  label: React.ReactNode;
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-small text-ink-2">
        {items.map((c, i) => (
          <li key={i} className="inline-flex items-center gap-1">
            {c.to ? (
              <Link to={c.to} className="underline-offset-4 hover:text-ink hover:underline">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink">
                {c.label}
              </span>
            )}
            {i < items.length - 1 ? (
              <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Page heading: breadcrumbs + h1, no subtitle (Pine rule 4); actions on the right. */
export function PageHeader({
  title,
  crumbs = [],
  actions,
  testId,
}: {
  title: React.ReactNode;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="grid gap-3">
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-h1 text-ink" data-testid={testId}>
          {title}
        </h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Page({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid min-w-0 content-start gap-6 p-8", className)} {...props} />;
}

/** Inline clinical/operational alert. tone=caution|critical carries an icon and a word (Pine rule 3). */
export function Alert({
  tone = "neutral",
  title,
  children,
  action,
  className,
  testId,
}: {
  tone?: "neutral" | "caution" | "critical";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const Icon = tone === "critical" ? OctagonAlert : tone === "caution" ? AlertTriangle : null;
  return (
    <div
      role={tone === "neutral" ? "status" : "alert"}
      data-testid={testId}
      className={cn(
        "flex items-start gap-3 px-4 py-3 text-body",
        tone === "critical"
          ? "bg-danger-bg text-danger-ink"
          : tone === "caution"
            ? "bg-caution-bg text-caution-ink"
            : "bg-surface-muted text-ink",
        className,
      )}
    >
      {Icon ? <Icon size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        {title ? <span className="font-semibold">{title} </span> : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse bg-surface-muted", className)} />;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}

/** Default list states (patterns.yaml default_states): empty, error, permission-denied. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="grid justify-items-center gap-2 px-6 py-12 text-center"
      data-testid="state-empty"
    >
      <SearchX size={24} strokeWidth={1.75} className="text-ink-2" aria-hidden />
      <p className="text-h3 text-ink">{title}</p>
      {children ? <p className="max-w-md text-body text-ink-2">{children}</p> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message = "We couldn't load this.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="grid justify-items-center gap-2 px-6 py-12 text-center"
      data-testid="state-error"
      role="alert"
    >
      <AlertTriangle size={24} strokeWidth={1.75} className="text-caution-ink" aria-hidden />
      <p className="text-h3 text-ink">{message}</p>
      <p className="text-body text-ink-2">Check your connection and try again.</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function PermissionDenied() {
  return (
    <div
      className="grid justify-items-center gap-2 px-6 py-12 text-center"
      data-testid="state-permission-denied"
    >
      <Lock size={24} strokeWidth={1.75} className="text-ink-2" aria-hidden />
      <p className="text-h3 text-ink">You don't have access</p>
      <p className="max-w-md text-body text-ink-2">
        Your role can't open this screen. Ask your practice manager if you need it.
      </p>
    </div>
  );
}

/** Definition list used in detail panes: label over value. */
export function Field({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-0.5 min-w-0", className)}>
      <dt className="text-small text-ink-2">{label}</dt>
      <dd className="text-body text-ink">{children ?? "—"}</dd>
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="grid gap-1" aria-label="Steps">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "flex h-row-compact items-center gap-3 px-3 text-body",
            i === current ? "bg-pine-50 font-semibold text-pine-700" : "text-ink-2",
          )}
        >
          <span
            className={cn(
              "grid size-6 place-items-center rounded-full text-caption",
              i < current
                ? "bg-pine-600 text-on-primary"
                : i === current
                  ? "bg-pine-600 text-on-primary"
                  : "bg-surface-muted text-ink",
            )}
          >
            {i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}
