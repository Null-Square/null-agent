import { describe, expect, it } from 'vitest';

import { extractRunTitleFromPlan, validateRunTitleFromPlan } from '@/domains/security-ops/runs/planTitle';

describe('planTitle helpers', () => {
  it('extracts the first markdown h1 as the run title', () => {
    expect(
      extractRunTitleFromPlan(`# Attack Surface Discovery for app.example.com

## Goal
Map the exposed web surface.`),
    ).toBe('Attack Surface Discovery for app.example.com');
  });

  it('rejects plans without a leading h1 heading', () => {
    expect(validateRunTitleFromPlan('## Goal\nTest auth flows.')).toContain('start with a level-1 heading');
  });

  it('rejects generic plan titles', () => {
    expect(validateRunTitleFromPlan('# Assessment Plan\n\n## Goal\nDo work.')).toContain('too generic');
  });

  it('accepts specific operational titles', () => {
    expect(
      validateRunTitleFromPlan('# Vulnerability Assessment for api.example.com\n\n## Goal\nAssess the API.'),
    ).toBeNull();
  });
});
