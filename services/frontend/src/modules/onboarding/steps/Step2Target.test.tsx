import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildTargetVerificationInstructions } from '@null-ai/contracts';
import Step2Target from './Step2Target';
import type { SetupFormData } from '../types';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const formData = (overrides: Partial<SetupFormData> = {}): SetupFormData => ({
  orgName: 'Acme',
  operationalContext: '',
  scopeName: 'Primary',
  mission: '',
  impactTolerance: 'non_destructive',
  complianceFrameworks: [],
  targetType: 'domain',
  targetValue: 'example.com',
  domainVerificationMethod: 'dns_txt',
  isTargetVerified: false,
  ...overrides,
});

const renderStep = (method: 'dns_txt' | 'http_well_known') =>
  render(
    <Step2Target
      data={formData({ domainVerificationMethod: method })}
      updateData={() => {}}
      verificationStatus="idle"
      verificationMessage=""
      verificationToken={TOKEN}
      isPolling={false}
      onVerify={async () => {}}
      isVerifying={false}
    />,
  );

const renderPendingStep = (overrides: Partial<ComponentProps<typeof Step2Target>> = {}) => {
  const onVerify = vi.fn(async () => {});
  const view = render(
    <Step2Target
      data={formData()}
      updateData={() => {}}
      verificationStatus="idle"
      verificationMessage=""
      verificationToken={null}
      isPolling={false}
      onVerify={onVerify}
      isVerifying={false}
      {...overrides}
    />,
  );
  return { ...view, onVerify };
};

describe('Step2Target onboarding verification UI', () => {
  const expected = buildTargetVerificationInstructions('example.com', TOKEN);

  it('renders the exact DNS host + value the backend checks', () => {
    renderStep('dns_txt');
    expect(expected.dnsHost).toBe('_nullsquare-verify.example.com');
    expect(expected.expectedValue).toBe(`ns-verify=${TOKEN}`);
    expect(screen.getByText(expected.dnsHost)).toBeTruthy();
    expect(screen.getByText(expected.expectedValue)).toBeTruthy();
  });

  it('renders the exact well-known URL + body the backend checks', () => {
    renderStep('http_well_known');
    expect(expected.httpUrl).toBe('https://example.com/.well-known/null-ai-verification.txt');
    expect(screen.getByText(expected.httpUrl)).toBeTruthy();
    expect(screen.getByText(expected.expectedValue)).toBeTruthy();
  });

  it('hides verification methods until a domain is entered', () => {
    renderPendingStep({
      data: formData({ targetValue: '' }),
    });

    expect(screen.queryByText(/verification method/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /show dns record instructions/i })).toBeNull();
  });

  it('offers DNS and HTTP verification straight away, with no hosted-provider detection', async () => {
    const { onVerify } = renderPendingStep();

    expect(screen.queryByText(/checking your website platform/i)).toBeNull();
    expect(screen.queryByText(/wordpress|squarespace|shopify|wix/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show dns record instructions/i }));

    expect(onVerify).toHaveBeenCalledTimes(1);
  });
});
