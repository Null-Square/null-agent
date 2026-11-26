import type { AssembledBehaviorScenario } from '../types';
import { harnessVerificationGateScenario } from './harnessVerificationGate';
import { interruptedResultSafetyScenario } from './interruptedResultSafety';
import { runtimeHostCapabilitiesScenario } from './runtimeHostCapabilities';
import { durableToolExecutionScenario } from './durableToolExecution';
import { atomicModelRequestScenario } from './atomicModelRequest';
import { contextMeasurementCompactionScenario } from './contextMeasurementCompaction';
import { contextOverflowRecoveryScenario } from './contextOverflowRecovery';
import { traceArtifactIntegrityScenario } from './traceArtifactIntegrity';
import { providerAttemptAccountingScenario } from './providerAttemptAccounting';
import { unifiedToolPipelineScenario } from './unifiedToolPipeline';
import { runTrajectoryReadModelScenario } from './runTrajectoryReadModel';
import { trajectoryWorkspaceScenario } from './trajectoryWorkspace';
import { cacheLineageExactPrefixScenario } from './cacheLineageExactPrefix';
import { harness32ConformanceScenario } from './harness32Conformance';
import { releaseAssuranceScenario } from './releaseAssurance';
import { toolTruthScenario } from './toolTruth';
import { shippingCompositionScenario } from './shippingComposition';

export const assembledScenarios: AssembledBehaviorScenario[] = [
  harnessVerificationGateScenario,
  interruptedResultSafetyScenario,
  runtimeHostCapabilitiesScenario,
  durableToolExecutionScenario,
  atomicModelRequestScenario,
  contextMeasurementCompactionScenario,
  contextOverflowRecoveryScenario,
  traceArtifactIntegrityScenario,
  providerAttemptAccountingScenario,
  unifiedToolPipelineScenario,
  runTrajectoryReadModelScenario,
  trajectoryWorkspaceScenario,
  cacheLineageExactPrefixScenario,
  harness32ConformanceScenario,
  toolTruthScenario,
  shippingCompositionScenario,
  releaseAssuranceScenario,
];
