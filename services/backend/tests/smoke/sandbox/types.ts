export type ManifestTool = {
  name: string;
  command: string;
  expect: string;
};

export type PhaseName =
  | 'sandbox-behavior'
  | 'core-runtime'
  | 'recon'
  | 'enumeration'
  | 'validation'
  | 'evidence';

export type SmokeCheck = {
  name: string;
  command: string;
  expect: string;
};

export type PhaseSmokeGroup = {
  phase: PhaseName;
  tools: string[];
  extraChecks?: SmokeCheck[];
};
