export type ScannerIngestorParams<TParsed, TContext = unknown> = {
  userId: string;
  workspaceDir: string;
  sessionId?: string;
  context?: TContext;
  parsed: TParsed;
};

export type ScannerIngestor<TParsed, TSummary, TContext = unknown> = (
  params: ScannerIngestorParams<TParsed, TContext>,
) => Promise<TSummary>;

export type ScannerParser =
  | 'subfinder'
  | 'naabu'
  | 'httpx'
  | 'nuclei'
  | 'katana'
  | 'ffuf'
  | 'openapi'
  | 'nmap'
  | 'dalfox'
  | 'gitleaks'
  | 'trufflehog'
  | 'trivy'
  | 'semgrep'
  | 'sqlmap';

export type ScannerAssetRef = {
  kind: 'domain' | 'ip';
  value: string;
};

export type ScannerSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type ScannerEvidenceRef = {
  path: string;
  label?: string;
  excerpt?: string;
};

export type ScannerCodeLocation = {
  pathKind: 'workspace' | 'repository';
  filePath: string;
  startLine: number;
  endLine: number;
  label?: string;
  fixBefore: string;
  fixAfter: string;
};

export type ScannerResolvedArtifact = {
  relativePath: string;
  absolutePath: string;
};

export type ScannerParsedInput<TParser extends string = string> = {
  parser: TParser;
  artifactPath?: string;
  rootAssetRef?: ScannerAssetRef;
  partial?: boolean;
};

export type IngestSummary<TParser extends string = ScannerParser> = {
  parser: TParser;
  artifactPath: string;
  partial?: boolean;
  assetsCreated: number;
  assetsTouched: number;
  servicesCreated: number;
  servicesTouched: number;
  subdomainNotesCreated: number;
  subdomainNotesTouched: number;
  endpointNotesCreated: number;
  endpointNotesTouched: number;
  techNotesCreated: number;
  techNotesTouched: number;
  observationsCreated: number;
  observationsTouched: number;
  findingsCreated: number;
  findingsTouched: number;
  skipped: number;
  suppressed: number;
  duplicates: number;
  noise: Record<string, number>;
};
