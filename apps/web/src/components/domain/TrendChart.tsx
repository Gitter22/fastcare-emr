import { formatShortDate } from "@/lib/format";

/**
 * Small line chart for a measurement trend (vitals, results). Ink lines on white, a dashed line for the alert
 * threshold, points labelled in a visually-hidden table for screen readers. No colour carries meaning.
 */
export interface TrendSeries {
  label: string;
  points: Array<{ at: string; value: number }>;
  dashed?: boolean;
}

export function TrendChart({
  series,
  threshold,
  height = 140,
  testId,
  caption,
}: {
  series: TrendSeries[];
  threshold?: { value: number; label: string };
  height?: number;
  testId?: string;
  caption: string;
}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <p className="py-6 text-body text-ink-2">No readings yet.</p>;
  const W = 360;
  const H = height;
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const times = all.map((p) => new Date(p.at).getTime());
  const values = [...all.map((p) => p.value), ...(threshold ? [threshold.value] : [])];
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const dataMin = Math.min(...all.map((p) => p.value));
  const dataMax = Math.max(...all.map((p) => p.value));
  const vMin = Math.floor(Math.min(...values) * 0.95);
  const vMax = Math.ceil(Math.max(...values) * 1.05);
  const x = (t: number) =>
    pad.l +
    (tMax === tMin ? (W - pad.l - pad.r) / 2 : ((t - tMin) / (tMax - tMin)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - vMin) / (vMax - vMin || 1)) * (H - pad.t - pad.b);
  return (
    <figure className="grid gap-2" data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" aria-hidden>
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={H - pad.b}
          y2={H - pad.b}
          className="stroke-line-strong"
          strokeWidth={1}
        />
        <text
          x={pad.l - 6}
          y={y(dataMax) + 4}
          textAnchor="end"
          className="fill-ink-2"
          fontSize={12}
        >
          {dataMax}
        </text>
        <text
          x={pad.l - 6}
          y={y(dataMin) + 4}
          textAnchor="end"
          className="fill-ink-2"
          fontSize={12}
        >
          {dataMin}
        </text>
        {threshold ? (
          <>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(threshold.value)}
              y2={y(threshold.value)}
              className="stroke-ink-2"
              strokeDasharray="5 4"
              strokeWidth={1}
            />
            <text
              x={pad.l + 4}
              y={y(threshold.value) - 4}
              textAnchor="start"
              className="fill-ink-2"
              fontSize={12}
            >
              {threshold.label}
            </text>
          </>
        ) : null}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => a.at.localeCompare(b.at));
          return (
            <g key={s.label}>
              <polyline
                fill="none"
                className="stroke-ink"
                strokeWidth={2}
                strokeDasharray={s.dashed ? "2 3" : undefined}
                points={pts.map((p) => `${x(new Date(p.at).getTime())},${y(p.value)}`).join(" ")}
              />
              {pts.map((p) => (
                <circle
                  key={p.at}
                  cx={x(new Date(p.at).getTime())}
                  cy={y(p.value)}
                  r={3}
                  className="fill-ink"
                />
              ))}
            </g>
          );
        })}
        <text x={pad.l} y={H - 6} className="fill-ink-2" fontSize={12}>
          {formatShortDate(new Date(tMin).toISOString())}
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="fill-ink-2" fontSize={12}>
          {formatShortDate(new Date(tMax).toISOString())}
        </text>
      </svg>
      <figcaption className="text-small text-ink-2">{caption}</figcaption>
      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {series.flatMap((s) =>
            s.points.map((p) => (
              <tr key={`${s.label}${p.at}`}>
                <td>{s.label}</td>
                <td>{formatShortDate(p.at)}</td>
                <td>{p.value}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </figure>
  );
}
