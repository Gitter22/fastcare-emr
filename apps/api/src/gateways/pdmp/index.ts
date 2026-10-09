import { randomInt } from "node:crypto";
import { getEnv } from "../../env.js";

/**
 * PdmpGateway (spec/integrations.yaml): state prescription drug monitoring program query (via the PMP hub / state
 * vendor) before prescribing a controlled substance (INV-SAFE-05). No state PDMP is contracted (OPEN-Q2) and
 * agile-emr only had a stub, so the only implementation is a simulated PDMP, connected only outside production. It
 * answers from the dispensations the simulated pharmacy network knows about (the caller passes them in), so a
 * prescription signed here shows up in the next report. In production with no vendor, `pdmpGateway()` is null and
 * a controlled prescription needs a recorded PDMP exception.
 */

export interface PdmpDispensation {
  drug: string;
  deaSchedule: string;
  filledAt: string;
  quantity: number;
  daysSupply: number | null;
  prescriber: string;
  pharmacy: string;
}

export interface PdmpReport {
  reportId: string;
  state: string;
  queriedAt: string;
  dispensations: PdmpDispensation[];
  /** Plain-language risk indicators the state returns (e.g. multiple prescribers). */
  indicators: string[];
}

export interface PdmpGateway {
  readonly vendor: "simulated";
  query(input: {
    state: string;
    patient: { lastName: string; firstName: string; birthDate: string; sex: string };
    knownDispensations: PdmpDispensation[];
  }): Promise<PdmpReport>;
}

export class PdmpUnavailableError extends Error {
  code = "PDMP_UNAVAILABLE";
}

export class SimulatedPdmpGateway implements PdmpGateway {
  readonly vendor = "simulated" as const;
  down = false;

  async query(input: {
    state: string;
    knownDispensations: PdmpDispensation[];
  }): Promise<PdmpReport> {
    if (this.down) throw new PdmpUnavailableError("The state PDMP is not responding.");
    const prescribers = new Set(input.knownDispensations.map((d) => d.prescriber));
    const pharmacies = new Set(input.knownDispensations.map((d) => d.pharmacy));
    const indicators: string[] = [];
    if (prescribers.size >= 3) indicators.push(`${prescribers.size} prescribers in 12 months`);
    if (pharmacies.size >= 3) indicators.push(`${pharmacies.size} pharmacies in 12 months`);
    return {
      reportId: `SIMPMP${String(randomInt(10_000_000, 99_999_999))}`,
      state: input.state,
      queriedAt: new Date().toISOString(),
      dispensations: input.knownDispensations,
      indicators,
    };
  }
}

let instance: SimulatedPdmpGateway | null = null;

export function isPdmpConnected(): boolean {
  return getEnv().NODE_ENV !== "production";
}

export function pdmpGateway(): PdmpGateway | null {
  if (!isPdmpConnected()) return null;
  return (instance ??= new SimulatedPdmpGateway());
}

export function simulatedPdmp(): SimulatedPdmpGateway {
  return (instance ??= new SimulatedPdmpGateway());
}
