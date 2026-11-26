import { describe, expect, it } from 'vitest';

import {
  getEnumerationWorkerAdmissionState,
  resolveEnumerationWorkerCapabilitySnapshot,
  stableEnumerationWorkerCohortBucket,
} from '@/domains/security-ops/runs/enumerationCapability';

describe('enumeration worker capability', () => {
  it('defaults off and supports the explicit allowlist cohort', () => {
    expect(resolveEnumerationWorkerCapabilitySnapshot({
      organizationId: 'org-1',
      env: {},
    })).toMatchObject({ enabled: false, cohort: 'disabled' });
    expect(resolveEnumerationWorkerCapabilitySnapshot({
      organizationId: 'org-1',
      env: {
        SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED: 'true',
        SECURITYOPS_ENUMERATION_WORKER_V1_ORG_IDS: 'org-1',
      },
    })).toMatchObject({ enabled: true, cohort: 'allowlist' });
  });

  it('uses stable organization cohorting and honors the live kill switch', () => {
    expect(stableEnumerationWorkerCohortBucket('org-1'))
      .toBe(stableEnumerationWorkerCohortBucket('org-1'));
    const snapshot = resolveEnumerationWorkerCapabilitySnapshot({
      organizationId: 'org-1',
      env: {
        SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED: 'true',
        SECURITYOPS_ENUMERATION_WORKER_V1_ORG_IDS: 'org-1',
      },
    });
    expect(getEnumerationWorkerAdmissionState({
      securityops: { enumerationWorkerV1: snapshot },
    }, {})).toMatchObject({
      allowed: false,
      reason: 'kill_switch_disabled',
    });
  });
});
