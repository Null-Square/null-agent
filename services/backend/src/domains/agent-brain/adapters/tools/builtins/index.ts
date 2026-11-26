/**
 * Adapters/Tools/Builtins
 * 
 * Built-in tool implementations: file, shell, web, browser, and plan.
 * 
 * Removed: checkpoint (not needed in sandbox env), web_fetch (replaced by http_payload)
 * 
 * @module agent-brain/adapters/tools/builtins
 */

// Marker for ToolManifestRegistry: this is a barrel/helper module, not a tool module definition.
export const __skipToolManifest = true as const;

// Export tool implementations (named exports)
export { FileRead, FileWrite, FileBuiltins, tools as fileTools } from './file';
export { ShellRun, WaitForShellJob, ShellBuiltins, tools as shellTools } from './shell';
export { PythonSession, PythonBuiltins, tools as pythonTools } from './python';
export { WebSearch, WebBuiltins, tools as webTools } from './web';
export { HttpPayload, HttpRawSend, BrowserBuiltins, tools as browserTools } from './browser';
export { HttpDifferential, tools as httpDifferentialTools } from './http_differential';
export { BrowserAction, BrowserActionBuiltins, tools as browserActionTools } from './browser_action';
export { HttpList, HttpView, HttpRepeat, HttpSitemap, tools as httpCaptureTools } from './http_capture';
export { OobTokenCreate, OobCheckInteractions, tools as oobTools } from './oob';
export { ListRelevantSkills, LoadSkill, tools as skillTools } from './skills';
export { TodoRead, TodoWrite, PlanSetStepStatus, PlanBuiltins, tools as planTools } from './plan';
export { SubmitPlan, tools as submitPlanTools } from './submit_plan';
export {
  ReconHandoffPreflight,
  EnumerationHandoffPreflight,
  ValidationHandoffPreflight,
  EvidenceHandoffPreflight,
  ControlAssessmentHandoffPreflight,
  ReportingHandoffPreflight,
  SubmitPhaseHandoff,
  SubmitPhaseCheckpoint,
  tools as phaseTools,
} from './phase';
export {
  SpawnWorker,
  ContinueWorker,
  StopWorker,
  WaitForWorker,
  SubmitWorkerResult,
  SubmitEnumerationDisposition,
  SubmitAttackDisposition,
  tools as workerTools,
} from './workers';
export {
  ReportAsset,
  ReportService,
  ReportNote,
  ReportFinding,
  PromoteFinding,
  SubmitFindingDispositionOutcome,
  SubmitValidationLeadOutcome,
  SubmitValidationOutcome,
  ReportFinalizerPreflight,
  PrepareReportContext,
  FinalizeRunArtifacts,
  QueryInventory,
  QueryFindings,
  QueryNotes,
  QueryComplianceReadiness,
  QueryComplianceEvidence,
  QueryComplianceMissingEvidence,
  QueryComplianceProofPackage,
  RecordControlCheck,
  RecordControlRequest,
  ReviewControlRequest,
  MapComplianceEvidence,
  AnnotateComplianceEvidence,
  PersonaSave,
  PersonaList,
  PersonaLoad,
  PersonaForget,
  AuthzReplay,
  ListCodeReviewRepositoryFiles,
  SearchCodeReviewRepository,
  QueryCodeReviewMemory,
  RecordCodeReviewMemory,
  ReportCodeReviewCandidate,
  QueryCodeReviewFindings,
  ValidateCodeReviewFinding,
  FinalizeCodeReviewReport,
  tools as securityOpsTools,
} from './securityops';

