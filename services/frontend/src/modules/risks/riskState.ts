import type { RiskState } from "../../local";

// The inbox and the detail workflow label the same persisted triage state.
export const RISK_STATE_LABELS: Record<RiskState, string> = {
  potential: "Potential",
  confirmed: "Confirmed",
  false_positive: "False positive",
  resolved: "Resolved",
  accepted: "Accepted",
};

export const riskStateLabel = (state: RiskState): string =>
  RISK_STATE_LABELS[state] ?? state;

export const isOpenRisk = (state?: RiskState): boolean =>
  state === "potential" || state === "confirmed";
