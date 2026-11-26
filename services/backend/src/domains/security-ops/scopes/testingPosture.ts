export type TestingPosture = 'black-box' | 'gray-box' | 'white-box';

export interface TestingPostureSignals {
  whiteboxEnabled: boolean;
  accessMaterialCount: number;
}

export interface TestingPostureResult {
  posture: TestingPosture;
  reason: string;
}

export function deriveTestingPosture(signals: TestingPostureSignals): TestingPostureResult {
  if (signals.whiteboxEnabled) {
    return {
      posture: 'white-box',
      reason: 'connected source repository present',
    };
  }
  if (signals.accessMaterialCount > 0) {
    return {
      posture: 'gray-box',
      reason: 'scope access materials provided',
    };
  }
  return {
    posture: 'black-box',
    reason: 'no source access or credentials attached',
  };
}

export const TESTING_POSTURE_LABELS: Record<TestingPosture, string> = {
  'black-box': 'Black-Box',
  'gray-box': 'Gray-Box',
  'white-box': 'White-Box',
};
