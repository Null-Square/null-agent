import type { CapacityProfileKey, RunRow } from '@/db/schema';
import type { CloudRunSchedulingConfig } from './CloudRunSchedulingConfig';

export type CapacityProfile = {
  key: CapacityProfileKey;
  version: number;
  memoryMb: number;
  containerSlots: number;
  cpuMillis: number | null;
  pidLimit: number | null;
};

export class CapacityProfileRegistry {
  constructor(private readonly config: CloudRunSchedulingConfig) {}

  get(key: CapacityProfileKey): CapacityProfile {
    return { key, ...this.config.profiles[key] };
  }

  classify(run: Pick<RunRow, 'admissionPurpose' | 'workflowDiscipline' | 'capacityProfile'>): CapacityProfile {
    if (run.capacityProfile) return this.get(run.capacityProfile);
    if (run.admissionPurpose === 'planning') return this.get('control');
    if (run.workflowDiscipline === 'code_review') return this.get('heavy');
    return this.get('standard');
  }
}
