import type {
  ContextProjection,
  CoverageProjection,
  FindingsProjection,
  LeadsProjection,
  ProjectRunWorkspaceInput,
  ReconProjection,
  SkillIndexEntry,
} from './WorkspaceProjectionTypes';
import {
  compareLeadsByPriority,
  firstString,
  getLeadPriority,
  getString,
  getStringArray,
  isRecord,
  MODEL_TOKEN_CHAR_CAP,
  renderList,
  truncate,
} from './WorkspaceProjectionHelpers';

export class WorkspaceProjectionRenderer {
  withMarker(projection: string, generatedAt: string, body: string): string {
    return [`<!-- generated-by: WorkspaceProjectionService ${projection}/v1 generatedAt=${generatedAt} -->`, '', body.trim(), ''].join('\n');
  }

  renderAgentsContract(input: ProjectRunWorkspaceInput, generatedAt: string): string {
    return [
      '# Agent Workspace Contract',
      '',
      `Generated: ${generatedAt}`,
      `Run: ${input.runId}`,
      '',
      'This workspace is a curated projection of canonical SecurityOps state. The database and SecurityOps tools are the source of truth.',
      '',
      'Start here:',
      '1. Read `journal/model.md`.',
      '2. Read your phase or mission context in TARGET CONTEXT.',
      '3. Read only the detail files needed for your current task.',
      '',
      'Rules:',
      '- Projection files are read-only.',
      '- Canonical writes must use SecurityOps tools.',
      '- Scanner output goes under `/workspace/.artifacts/scans/<tool-or-task>/` before `ingest_scan_artifact`.',
      '- Assigned skill methodology lives under `/workspace/.skills/<slug>/`.',
      '- Evidence files go under `/workspace/evidence/` or your assigned worker write scope.',
      '- Reports go under `/workspace/report/`, with `summary.md` and `report.md` kept in the workspace root for compatibility.',
      '- Workers may only write inside their assigned write scope.',
      '- If a projection looks stale, use canonical query tools and mention the stale projection in handoff.',
      '',
    ].join('\n');
  }

  renderArtifactsReadme(): string {
    return [
      '# Compatibility Artifact Directory',
      '',
      'This directory remains the durable artifact compatibility path.',
      '',
      '- `.artifacts/scans/`: scanner output for `ingest_scan_artifact` auto-discovery.',
      '- `.artifacts/phases/<phase>/`: phase-owned working artifacts.',
      '- `.artifacts/phase-handoffs/`: structured phase handoff JSON.',
      '- `.artifacts/report/`: generated report support artifacts.',
      '',
      'For the full workspace contract, read `/workspace/AGENTS.md`.',
      '',
    ].join('\n');
  }

  renderOrganizationMarkdown(context: ContextProjection): string {
    const org = context.organization;
    return [
      '# Organization Context',
      '',
      `Organization: ${org?.name ?? 'unknown'}`,
      `Slug: ${org?.slug ?? 'unknown'}`,
      '',
      '## Operational Context',
      org?.operationalContext?.trim() || 'No operational context projected.',
    ].join('\n');
  }

  renderScopeMarkdown(context: ContextProjection): string {
    const scope = context.scope;
    const org = context.organization;
    return [
      '# Scope Context',
      '',
      `Organization: ${org?.name ?? 'unknown'}`,
      `Scope: ${scope?.name ?? 'unknown'}`,
      `Mission: ${scope?.mission ?? 'not specified'}`,
      `Compliance frameworks: ${(scope?.complianceFrameworks ?? []).join(', ') || 'none selected'}`,
      '',
      '## Targets',
      ...renderList(
        context.targets.map((target) => `${target.type} ${target.value} (${target.verified ? 'verified' : 'unverified'})`),
        'no targets projected',
      ),
    ].join('\n');
  }

  renderRoeMarkdown(context: ContextProjection): string {
    const scope = context.scope;
    const impactGuidance = scope?.impactTolerance === 'non_destructive'
      ? 'Do not alter production data.'
      : scope?.impactTolerance === 'full'
        ? 'Full impact remains limited to the separately authorized, resettable environment and objective.'
        : 'Normal PoC permits bounded, reversible proof on evaluator-owned state. Material impact remains prohibited.';
    return [
      '# Rules Of Engagement',
      '',
      `Impact tolerance: ${scope?.impactTolerance ?? 'unknown'}`,
      'Verified scope targets and explicit exclusions define the authoritative testing boundary.',
      impactGuidance,
    ].join('\n');
  }

  renderExecutionMarkdown(context: ContextProjection): string {
    const scope = context.scope;
    const run = context.run;
    return [
      '# Execution Context',
      '',
      `Execution network: ${scope?.executionNetwork ?? 'unknown'}`,
      `Execution target: ${run?.executionTarget ?? 'unknown'}`,
      `Runner ID: ${run?.runnerId ?? 'none'}`,
      `Run status: ${run?.status ?? 'unknown'}`,
    ].join('\n');
  }

  renderAccessMarkdown(context: ContextProjection): string {
    return [
      '# Access And Persona Metadata',
      '',
      'Secrets are not projected into this file.',
      '',
      '## Access Materials',
      '',
      ...renderList(
        context.accessMaterials.map((material) => {
          const hostText = material.appliesToHosts.length > 0 ? ` hosts=${material.appliesToHosts.join(',')}` : '';
          return `${material.kind} "${material.label}"${material.username ? ` user=${material.username}` : ''}${material.headerName ? ` header=${material.headerName}` : ''}${hostText}`;
        }),
        'no access material metadata projected',
      ),
      '',
      '## Test Personas',
      '',
      ...renderList(
        context.personas.map((persona) => {
          const hostText = persona.appliesToHosts.length > 0 ? ` hosts=${persona.appliesToHosts.join(',')}` : '';
          const roleText = persona.roleLabel ? ` role=${persona.roleLabel}` : '';
          const userText = persona.username ? ` user=${persona.username}` : '';
          const headerText = persona.headerName ? ` header=${persona.headerName}` : '';
          const refreshText = persona.refreshConfigured ? ' refresh=configured' : '';
          return `${persona.kind} "${persona.label}"${roleText}${userText}${headerText}${hostText}${refreshText}`;
        }),
        'no test personas projected',
      ),
    ].join('\n');
  }

  renderPriorRunsMarkdown(context: ContextProjection): string {
    const lines = context.priorRunNotes.slice(0, 50).map((note) => {
      const ntype = getString(note.ntype) ?? 'note';
      const title = getString(note.title) ?? truncate(JSON.stringify(note.data), 140);
      const lastSeenAt = getString(note.lastSeenAt) ?? 'unknown time';
      return `${ntype}: ${title} (${lastSeenAt})`;
    });
    return [
      '# Prior Run And Attempt Ledger',
      '',
      'Use this to avoid repeated dead ends. Canonical detail remains in query_notes.',
      '',
      ...renderList(lines, 'no prior run digests, blockers, or tried approaches projected'),
    ].join('\n');
  }

  renderSurfaceMarkdown(recon: ReconProjection): string {
    const assetLines = recon.assets.slice(0, 20).map((asset) => {
      const row = asset as { value?: string; kind?: string };
      return `${row.value ?? 'unknown'} (${row.kind ?? 'asset'})`;
    });
    const endpointLines = recon.endpoints.slice(0, 30).map((endpoint) => {
      const row = endpoint as Record<string, unknown>;
      const risks = getStringArray(row.riskSignals).length > 0 ? ` risks=${getStringArray(row.riskSignals).join(',')}` : '';
      return truncate(
        `${firstString(row.method) ?? 'GET'} ${firstString(row.url, row.path, row.title) ?? 'endpoint'}${risks}`,
        220,
      );
    });
    const riskyEndpointLines = recon.endpointSummary.risky.slice(0, 15).map((endpoint) => {
      const risks = getStringArray(endpoint.riskSignals).join(',');
      return truncate(`${firstString(endpoint.method) ?? 'GET'} ${firstString(endpoint.url, endpoint.path) ?? 'endpoint'} (${risks})`, 220);
    });
    return [
      '# Surface Summary',
      '',
      `Assets: ${recon.assets.length}`,
      `Services: ${recon.services.length}`,
      `Endpoints: ${recon.endpoints.length}`,
      `Technologies: ${recon.technologies.length}`,
      '',
      '## High-Signal Assets',
      ...renderList(assetLines, 'no assets projected'),
      '',
      '## Recent Endpoints',
      ...renderList(endpointLines, 'no endpoints projected'),
      '',
      '## Risk-Signaled Endpoints',
      ...renderList(riskyEndpointLines, 'no risk-signaled endpoints projected'),
    ].join('\n');
  }

  renderCoverageMarkdown(coverage: CoverageProjection): string {
    const matrixLines = coverage.matrix.slice(0, 30).map((entry) => {
      const family = firstString(entry.family) ?? 'unknown';
      return `${family}: completed=${String(entry.completed ?? 0)} blocked=${String(entry.blocked ?? 0)} observations=${String(entry.observations ?? 0)}`;
    });
    return [
      '# Coverage Ledger',
      '',
      `Coverage notes: ${coverage.notes.length}`,
      `Scanner observations: ${coverage.scannerObservations.length}`,
      '',
      '## Matrix',
      ...renderList(matrixLines, 'no coverage families projected'),
      '',
      '## Gaps',
      ...renderList(coverage.gaps, 'no deterministic coverage gaps projected'),
      '',
      '## Blockers',
      ...renderList(coverage.blockers.slice(0, 20), 'no coverage blockers projected'),
    ].join('\n');
  }

  renderLeadsMarkdown(leads: LeadsProjection): string {
    const leadLines = [...leads.validationLeads].sort(compareLeadsByPriority).slice(0, 50).map((lead) => {
      const row = lead as { title?: string | null; data?: Record<string, unknown> };
      const priority = getLeadPriority(lead);
      const status = firstString(row.data?.status) ?? 'open';
      const label = truncate(firstString(row.title, row.data?.hypothesis, JSON.stringify(row.data)) ?? 'validation lead', 170);
      const reason = priority.reasons.length > 0 ? ` (${priority.reasons.join(', ')})` : '';
      return `[${priority.band} ${priority.score}] ${status}: ${label}${reason}`;
    });
    return [
      '# Lead Board',
      '',
      `Validation leads: ${leads.validationLeads.length}`,
      `Validation queue items: ${leads.validationQueue.length}`,
      '',
      '## Leads',
      ...renderList(leadLines, 'no validation leads projected'),
    ].join('\n');
  }

  renderFindingsMarkdown(projection: FindingsProjection): string {
    const lines = projection.findings.slice(0, 50).map((finding) => {
      const title = getString(finding.title) ?? 'untitled finding';
      return `${finding.severity ?? 'unknown'} ${finding.state ?? 'unknown'}: ${title}`;
    });
    return [
      '# Finding Board',
      '',
      `Total findings: ${projection.findings.length}`,
      `Candidates: ${projection.candidates.length}`,
      `Reportable: ${projection.reportable.length}`,
      '',
      ...renderList(lines, 'no findings projected'),
    ].join('\n');
  }

  renderSkillsMarkdown(catalog: SkillIndexEntry[]): string {
    return [
      '# Skill Index',
      '',
      'Full methodology is synced only for assigned or loaded skills under `/workspace/.skills/<slug>/`.',
      '',
      ...renderList(
        catalog.map((skill) => {
          const triggers = [
            skill.strongTerms.length > 0 ? `strong=${skill.strongTerms.slice(0, 6).join(',')}` : '',
            skill.techTriggers.length > 0 ? `tech=${skill.techTriggers.slice(0, 4).join(',')}` : '',
            skill.ntypeTriggers.length > 0 ? `ntype=${skill.ntypeTriggers.slice(0, 4).join(',')}` : '',
          ].filter(Boolean).join('; ');
          return `${skill.slug} (${skill.phase ?? 'unknown'}): ${skill.description}${triggers ? ` [${triggers}]` : ''}`;
        }),
        'no skills loaded',
      ),
    ].join('\n');
  }

  renderActiveSkillsMarkdown(activeSkillSlugs: string[]): string {
    return [
      '# Active Skills',
      '',
      ...renderList(
        activeSkillSlugs.map((slug) => `${slug}: /workspace/.skills/${slug}/methodology.md`),
        'no active phase skills projected',
      ),
    ].join('\n');
  }

  renderScanDigestMarkdown(value: Record<string, unknown>): string {
    const totals = isRecord(value.totals) ? value.totals : {};
    const highSignal = Array.isArray(value.highSignal) ? value.highSignal as Record<string, unknown>[] : [];
    const topHosts = Array.isArray(value.topHosts) ? value.topHosts as Record<string, unknown>[] : [];
    const topEndpoints = Array.isArray(value.topEndpoints) ? value.topEndpoints as Record<string, unknown>[] : [];
    const topArtifacts = Array.isArray(value.topArtifacts) ? value.topArtifacts as Record<string, unknown>[] : [];
    const projectedInventory = isRecord(value.projectedInventory) ? value.projectedInventory : {};
    const projectedRisky = Array.isArray(projectedInventory.riskyEndpoints)
      ? projectedInventory.riskyEndpoints as Record<string, unknown>[]
      : [];
    const projectedRecent = Array.isArray(projectedInventory.recentEndpoints)
      ? projectedInventory.recentEndpoints as Record<string, unknown>[]
      : [];
    const projectedTech = Array.isArray(projectedInventory.technologies)
      ? projectedInventory.technologies as Record<string, unknown>[]
      : [];
    const projectedGaps = Array.isArray(projectedInventory.coverageGaps)
      ? projectedInventory.coverageGaps.map(String)
      : [];
    const highSignalLines = highSignal.slice(0, 20).map((row) =>
      truncate(`${String(row.severity ?? 'info')} ${String(row.parser ?? row.sourceTool ?? 'scanner')}: ${String(row.title ?? row.observationType ?? 'observation')} (${String(row.artifactPath ?? 'no artifact')})`, 220),
    );
    const hostLines = topHosts.slice(0, 20).map((row) =>
      `${String(row.host ?? 'unknown-host')}: ${String(row.observations ?? 0)} observations, highest=${String(row.highestSeverity ?? 'info')}`,
    );
    const endpointLines = topEndpoints.slice(0, 25).map((row) =>
      truncate(`${String(row.method ?? 'GET')} ${String(row.host ?? 'unknown-host')}${String(row.path ?? '')}: ${String(row.observations ?? 0)} observations, highest=${String(row.highestSeverity ?? 'info')}`, 220),
    );
    const artifactLines = topArtifacts.slice(0, 15).map((row) =>
      `${String(row.artifactPath ?? 'artifact')}: ${String(row.observations ?? 0)} observations, highest=${String(row.highestSeverity ?? 'info')}`,
    );
    const riskyLines = projectedRisky.slice(0, 20).map((row) =>
      truncate(`${String(row.method ?? 'GET')} ${String(row.host ?? 'unknown-host')}${String(row.path ?? row.url ?? '')}: signals=${Array.isArray(row.riskSignals) ? row.riskSignals.join(',') : 'none'}`, 220),
    );
    const recentEndpointLines = projectedRecent.slice(0, 20).map((row) =>
      truncate(`${String(row.method ?? 'GET')} ${String(row.host ?? 'unknown-host')}${String(row.path ?? row.url ?? '')}`, 220),
    );
    const techLines = projectedTech.slice(0, 20).map((row) =>
      truncate(`${String(row.title ?? row.name ?? 'technology')}: ${JSON.stringify(row.data ?? {}).slice(0, 160)}`, 220),
    );
    return [
      '# Scan Digest',
      '',
      `Observations: ${String(totals.observations ?? 0)}`,
      `Hosts summarized: ${String(totals.hostCount ?? 0)}`,
      `Endpoints summarized: ${String(totals.endpointCount ?? 0)}`,
      `Artifacts summarized: ${String(totals.artifactCount ?? 0)}`,
      `Projected endpoints: ${String(totals.projectedEndpointCount ?? 0)}`,
      `Projected technologies: ${String(totals.projectedTechnologyCount ?? 0)}`,
      `Coverage notes: ${String(totals.coverageNoteCount ?? 0)}`,
      '',
      '## High-Signal Observations',
      ...renderList(highSignalLines, 'no medium-or-higher scanner observations projected'),
      '',
      '## Projected Risky Endpoints',
      ...renderList(riskyLines, 'no risk-signaled projected endpoints'),
      '',
      '## Projected Recent Endpoints',
      ...renderList(recentEndpointLines, 'no projected endpoints'),
      '',
      '## Projected Technologies',
      ...renderList(techLines, 'no projected technologies'),
      '',
      '## Coverage Gaps',
      ...renderList(projectedGaps.slice(0, 20), 'no projected coverage gaps'),
      '',
      '## Top Hosts',
      ...renderList(hostLines, 'no scanner hosts projected'),
      '',
      '## Top Endpoints',
      ...renderList(endpointLines, 'no scanner endpoints projected'),
      '',
      '## Top Artifacts',
      ...renderList(artifactLines, 'no scanner artifacts projected'),
      '',
      String(value.rawReadPolicy ?? 'Read raw scanner artifacts only when this digest does not contain enough detail.'),
    ].join('\n');
  }

  renderModelMarkdown(model: Record<string, unknown>): string {
    const surface = isRecord(model.surface) ? model.surface : {};
    const coverage = isRecord(model.coverage) ? model.coverage : {};
    const endpointSummary = isRecord(surface.endpointSummary) ? surface.endpointSummary : {};
    const leads = isRecord(model.leads) ? model.leads : {};
    const findingsModel = isRecord(model.findings) ? model.findings : {};
    const doNotRetry = Array.isArray(model.doNotRetry) ? model.doNotRetry.map(String).filter(Boolean) : [];
    const detailFiles = Array.isArray(model.detailFiles) ? model.detailFiles.map(String) : [];

    const body = [
      '# Live Engagement Model',
      '',
      '## Surface',
      `Assets: ${String(surface.assetCount ?? 0)}`,
      `Services: ${String(surface.serviceCount ?? 0)}`,
      `Endpoints: ${String(surface.endpointCount ?? 0)}`,
      `Technologies: ${String(surface.technologyCount ?? 0)}`,
      `Risk-signaled endpoints: ${Array.isArray(endpointSummary.risky) ? endpointSummary.risky.length : 0}`,
      '',
      '## Coverage',
      `Coverage notes: ${String(coverage.noteCount ?? 0)}`,
      `Scanner observations: ${String(coverage.scannerObservationCount ?? 0)}`,
      ...renderList(Array.isArray(coverage.gaps) ? coverage.gaps.map(String) : [], 'no projected coverage gaps'),
      ...renderList(Array.isArray(coverage.blockers) ? coverage.blockers.map((item) => `blocker: ${String(item)}`) : [], 'no projected coverage blockers'),
      '',
      '## Leads And Findings',
      `Open leads: ${Array.isArray(leads.open) ? leads.open.length : 0}`,
      `Queued validations: ${Array.isArray(leads.queue) ? leads.queue.length : 0}`,
      `Candidate findings: ${String(findingsModel.candidates ? (findingsModel.candidates as unknown[]).length : 0)}`,
      `Reportable findings: ${String(findingsModel.reportable ? (findingsModel.reportable as unknown[]).length : 0)}`,
      '',
      '## Do Not Retry',
      ...renderList(doNotRetry, 'no blocked or ruled-out approaches projected'),
      '',
      '## Detail Files',
      ...renderList(detailFiles, 'no detail files projected'),
    ].join('\n');

    if (body.length <= MODEL_TOKEN_CHAR_CAP) {
      return body;
    }
    return `${body.slice(0, MODEL_TOKEN_CHAR_CAP)}\n\nProjection was truncated. Read detail files for full state.\n`;
  }
}
