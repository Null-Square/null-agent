import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import Step3Authorize from './Step3Authorize';
import type { SetupFormData } from '../types';

const formData = (overrides: Partial<SetupFormData> = {}): SetupFormData => ({
  orgName: 'Acme',
  operationalContext: '',
  scopeName: 'Primary',
  mission: '',
  impactTolerance: 'poc',
  complianceFrameworks: [],
  targetType: 'domain',
  targetValue: 'example.com',
  domainVerificationMethod: 'dns_txt',
  isTargetVerified: false,
  ...overrides,
});

const renderStep = (overrides: Partial<ComponentProps<typeof Step3Authorize>> = {}) =>
  render(<Step3Authorize data={formData()} organizationName="Acme" {...overrides} />);

describe('Step3Authorize', () => {
  it('states the terms the statement covers', () => {
    renderStep();

    expect(screen.getByText('What you are authorizing')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('Bounded proof of concept')).toBeInTheDocument();
    expect(screen.getByText(/I confirm that my organization owns the targets/i)).toBeInTheDocument();
  });

  /* Authorization is a decision, not a form field: there is one action, and it
     is the wizard's primary button. Offering "No" would be a dead end. */
  it('offers no checkbox and no decline control', () => {
    renderStep();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /decline|no,/i })).toBeNull();
  });

  /* Proving control of the domain belongs beside the website it describes, on
     the step before. This one carries the warranty and nothing else. */
  it('carries no verification record of its own', () => {
    renderStep();

    expect(screen.queryByText(/_nullsquare-verify/)).toBeNull();
    expect(screen.queryByRole('button', { name: /verify & start discovery/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /show dns record instructions/i })).toBeNull();
  });

  it('says where verification stands rather than claiming to start it', () => {
    renderStep();
    expect(screen.getByText('Verification pending')).toBeInTheDocument();
    expect(screen.getByText(/watching for the verification record/i)).toBeInTheDocument();
  });

  it('reports a verified website and the assessment already running', () => {
    renderStep({ data: formData({ isTargetVerified: true }) });

    expect(screen.getByText('Ownership verified')).toBeInTheDocument();
    expect(screen.getByText(/discovery assessment has started/i)).toBeInTheDocument();
  });
});
