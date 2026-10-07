import { create } from "zustand";

/**
 * Open chart tabs (ADR-001, NAV-04). Up to `max` charts (practice setting chart.maxOpenCharts, OPEN-Q9 default 3);
 * opening one more closes the oldest unpinned tab. Closing the last returns to the last non-chart route.
 */
export interface OpenChart {
  patientId: string;
  label: string;
  pinned?: boolean;
  /** Last route visited inside this chart, so switching tabs returns there. */
  lastPath?: string;
}

interface ChartState {
  charts: OpenChart[];
  max: number;
  lastNonChartPath: string;
  open: (c: OpenChart) => void;
  close: (patientId: string) => string | null;
  rememberPath: (patientId: string, path: string) => void;
  setLastNonChart: (path: string) => void;
  setMax: (n: number) => void;
  relabel: (patientId: string, label: string) => void;
  reset: () => void;
}

export const useCharts = create<ChartState>((set, get) => ({
  charts: [],
  max: 3,
  lastNonChartPath: "/",
  open: (c) =>
    set((s) => {
      if (s.charts.some((x) => x.patientId === c.patientId)) return s;
      let charts = [...s.charts, c];
      while (charts.length > s.max) {
        const idx = charts.findIndex((x) => !x.pinned);
        if (idx < 0) break;
        charts = charts.filter((_, i) => i !== idx);
      }
      return { charts };
    }),
  close: (patientId) => {
    const charts = get().charts.filter((c) => c.patientId !== patientId);
    set({ charts });
    const next = charts[charts.length - 1];
    return next ? (next.lastPath ?? `/patient/${next.patientId}/summary`) : get().lastNonChartPath;
  },
  rememberPath: (patientId, path) =>
    set((s) => ({
      charts: s.charts.map((c) => (c.patientId === patientId ? { ...c, lastPath: path } : c)),
    })),
  setLastNonChart: (path) => set({ lastNonChartPath: path }),
  setMax: (n) => set({ max: Math.max(1, n) }),
  relabel: (patientId, label) =>
    set((s) => ({
      charts: s.charts.map((c) => (c.patientId === patientId ? { ...c, label } : c)),
    })),
  reset: () => set({ charts: [] }),
}));
