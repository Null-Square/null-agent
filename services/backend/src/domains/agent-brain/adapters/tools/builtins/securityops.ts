import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';

import { IngestScanArtifact } from './securityops/ingestion';
import { FinalizeRunArtifacts, PrepareReportContext, ReportFinalizerPreflight } from './securityops/finalize';
import { SubmitExposureVerification } from './securityops/exposure';
import { PromoteFinding, SubmitFindingDispositionOutcome, SubmitValidationLeadOutcome, SubmitValidationOutcome } from './securityops/findings';
import { QueryComplianceEvidence, QueryComplianceMissingEvidence, QueryComplianceProofPackage, QueryComplianceReadiness, QueryFindings, QueryInventory, QueryNotes } from './securityops/query';
import { ListConnectedRepositories, ReadConnectedRepositoryFile, SearchConnectedRepository } from './securityops/repositories';
import { ReportAsset, ReportFinding, ReportNote, ReportService } from './securityops/reporting';
import { AuthzReplay, PersonaForget, PersonaList, PersonaLoad, PersonaSave } from './securityops/personas';
import { AnnotateComplianceEvidence, MapComplianceEvidence, RecordControlCheck, RecordControlRequest, ReviewControlRequest } from './securityops/compliance';
import { AddScopeTarget, CreateScopeAutomation, ReadSetupState, UpdateOrganizationContext, UpdateScopeBrief } from './securityops/setup';
import { ListRelevantSetupSkills, LoadSetupSkill } from './securityops/setupSkills';
import { ReadScopeDocument } from './securityops/setupDocuments';
import {
  FinalizeCodeReviewReport,
  ListCodeReviewRepositoryFiles,
  QueryCodeReviewFindings,
  QueryCodeReviewMemory,
  RecordCodeReviewMemory,
  ReportCodeReviewCandidate,
  SearchCodeReviewRepository,
  ValidateCodeReviewFinding,
} from './securityops/codeReview';

export { IngestScanArtifact } from './securityops/ingestion';
export { FinalizeRunArtifacts, PrepareReportContext, ReportFinalizerPreflight } from './securityops/finalize';
export { SubmitExposureVerification } from './securityops/exposure';
export { PromoteFinding, SubmitFindingDispositionOutcome, SubmitValidationLeadOutcome, SubmitValidationOutcome } from './securityops/findings';
export { QueryComplianceEvidence, QueryComplianceMissingEvidence, QueryComplianceProofPackage, QueryComplianceReadiness, QueryFindings, QueryInventory, QueryNotes } from './securityops/query';
export { ListConnectedRepositories, ReadConnectedRepositoryFile, SearchConnectedRepository } from './securityops/repositories';
export { ReportAsset, ReportFinding, ReportNote, ReportService } from './securityops/reporting';
export { AuthzReplay, PersonaForget, PersonaList, PersonaLoad, PersonaSave } from './securityops/personas';
export { AnnotateComplianceEvidence, MapComplianceEvidence, RecordControlCheck, RecordControlRequest, ReviewControlRequest } from './securityops/compliance';
export { AddScopeTarget, CreateScopeAutomation, ReadSetupState, UpdateOrganizationContext, UpdateScopeBrief } from './securityops/setup';
export { ListRelevantSetupSkills, LoadSetupSkill } from './securityops/setupSkills';
export { ReadScopeDocument } from './securityops/setupDocuments';
export {
  FinalizeCodeReviewReport,
  ListCodeReviewRepositoryFiles,
  QueryCodeReviewFindings,
  QueryCodeReviewMemory,
  RecordCodeReviewMemory,
  ReportCodeReviewCandidate,
  SearchCodeReviewRepository,
  ValidateCodeReviewFinding,
} from './securityops/codeReview';
export { isReportingHandoffRecorded } from './securityops/shared';

export const tools: ToolModuleDefinition[] = [
  ReportAsset,
  ReportService,
  IngestScanArtifact,
  ReportNote,
  ReportFinding,
  PromoteFinding,
  SubmitFindingDispositionOutcome,
  SubmitValidationLeadOutcome,
  SubmitValidationOutcome,
  SubmitExposureVerification,
  ReportFinalizerPreflight,
  PrepareReportContext,
  FinalizeRunArtifacts,
  QueryInventory,
  QueryFindings,
  QueryNotes,
  QueryComplianceReadiness,
  QueryComplianceEvidence,
  QueryComplianceProofPackage,
  QueryComplianceMissingEvidence,
  ReadSetupState,
  UpdateOrganizationContext,
  UpdateScopeBrief,
  AddScopeTarget,
  CreateScopeAutomation,
  ListRelevantSetupSkills,
  LoadSetupSkill,
  ReadScopeDocument,
  RecordControlCheck,
  RecordControlRequest,
  ReviewControlRequest,
  MapComplianceEvidence,
  AnnotateComplianceEvidence,
  ListConnectedRepositories,
  SearchConnectedRepository,
  ReadConnectedRepositoryFile,
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
].map(fromToolImpl);
