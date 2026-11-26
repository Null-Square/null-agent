import type { BehaviorScenario } from '../types';
import { delegationScenarios } from './delegation';
import { depthToolScenarios } from './depthTools';
import { phaseScenarios } from './phase';
import { plannerScenarios } from './planner';
import { reconScenarios } from './recon';
import { reportingScenarios } from './reporting';
import { shellScenarios } from './shell';
import { validationScenarios } from './validation';

export const scenarios: BehaviorScenario[] = [
  ...plannerScenarios,
  ...validationScenarios,
  ...depthToolScenarios,
  ...reconScenarios,
  ...reportingScenarios,
  ...delegationScenarios,
  ...shellScenarios,
  ...phaseScenarios,
];
