import type { PhaseSmokeGroup } from '../types';
import { coreRuntimeGroup } from './coreRuntime';
import { enumerationGroup } from './enumeration';
import { evidenceGroup } from './evidence';
import { reconGroup } from './recon';
import { sandboxBehaviorGroup } from './sandboxBehavior';
import { validationGroup } from './validation';

export const PHASE_SMOKE_GROUPS: PhaseSmokeGroup[] = [
  sandboxBehaviorGroup,
  coreRuntimeGroup,
  reconGroup,
  enumerationGroup,
  validationGroup,
  evidenceGroup,
];
