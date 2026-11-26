import { describe, expect, it } from 'vitest';

import { assertRunReportWorkflowSupported } from '@/domains/security-ops/tools/reporting/RunReportWorkflowService';

describe('Code Review report routing', () => {
  it('fails closed instead of using the Pentest report workflow', () => {
    expect(() =>
      assertRunReportWorkflowSupported({
        workflowDiscipline: 'code_review',
      }),
    ).toThrow('cannot fall back to Pentest reporting');
  });

  it('preserves the existing Pentest and Compliance report workflows', () => {
    expect(() => assertRunReportWorkflowSupported({ workflowDiscipline: 'pentest' })).not.toThrow();
    expect(() => assertRunReportWorkflowSupported({ workflowDiscipline: 'compliance' })).not.toThrow();
  });
});
