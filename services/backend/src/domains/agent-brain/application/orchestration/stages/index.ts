/**
 * Orchestrator Pipeline Stages
 * @module agent-brain/application/orchestration/stages
 */

// Types (all Args/Result interfaces and stage interfaces)
export * from './types';

// Stage implementations
export { DefaultPrepareStage } from './PrepareStage';
export { DefaultBuildStage } from './BuildStage';
export { DefaultReconcileStage } from './ReconcileStage';

// Import default stages for factory
import { DefaultPrepareStage } from './PrepareStage';
import { DefaultBuildStage } from './BuildStage';
import { DefaultReconcileStage } from './ReconcileStage';

/**
 * Expose default stage classes for targeted unit testing
 */
export const DefaultStages = {
  Prepare: DefaultPrepareStage,
  Build: DefaultBuildStage,
  Reconcile: DefaultReconcileStage,
};
