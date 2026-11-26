import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';

import { SubmitPhaseCheckpoint, SubmitPhaseHandoff } from './phase/handoff';
import { ControlAssessmentHandoffPreflight, EnumerationHandoffPreflight, EvidenceHandoffPreflight, ReconHandoffPreflight, ReportingHandoffPreflight, ValidationHandoffPreflight } from './phase/preflight';

export { SubmitPhaseCheckpoint, SubmitPhaseHandoff } from './phase/handoff';
export { ControlAssessmentHandoffPreflight, EnumerationHandoffPreflight, EvidenceHandoffPreflight, ReconHandoffPreflight, ReportingHandoffPreflight, ValidationHandoffPreflight } from './phase/preflight';

export const tools: ToolModuleDefinition[] = [
  ReconHandoffPreflight,
  EnumerationHandoffPreflight,
  ValidationHandoffPreflight,
  EvidenceHandoffPreflight,
  ControlAssessmentHandoffPreflight,
  ReportingHandoffPreflight,
  SubmitPhaseHandoff,
  SubmitPhaseCheckpoint,
].map(fromToolImpl);
