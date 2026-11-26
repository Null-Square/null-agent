import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checks = vi.hoisted(() => ({
  checkDnsTxt: vi.fn(),
  checkHttpWellKnown: vi.fn(),
}));

vi.mock('@/domains/security-ops/scopes/verificationChecks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domains/security-ops/scopes/verificationChecks')>()),
  checkDnsTxt: checks.checkDnsTxt,
  checkHttpWellKnown: checks.checkHttpWellKnown,
}));

import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { isLabTarget, labTargetHosts } from '@/domains/security-ops/scopes/verificationChecks';

const NOT_FOUND = { verified: false, reason: 'not_found', message: 'No TXT record found yet.' } as const;

const pendingTarget = (type: 'domain' | 'cidr', value: string) => ({
  id: 'target-1',
  scopeId: 'scope-1',
  type,
  value,
  verified: false,
  verificationMethod: type === 'cidr' ? 'manual_review' : 'dns_txt',
  verificationToken: type === 'cidr' ? null : 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
});

const serviceFor = (target: Record<string, unknown>) => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [target]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updates.push(values);
          return [];
        }),
      })),
    })),
  };
  return { service: new ScopeService(db as never), updates };
};

beforeEach(() => {
  checks.checkDnsTxt.mockReset().mockResolvedValue(NOT_FOUND);
  checks.checkHttpWellKnown.mockReset().mockResolvedValue(NOT_FOUND);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lab target verification', () => {
  it('verifies a host listed in NULL_AI_LAB_TARGETS as method lab, without a DNS or file check', async () => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', 'juice-shop.lab');
    const { service, updates } = serviceFor(pendingTarget('domain', 'juice-shop.lab'));

    const result = await service.verifyTarget('scope-1', 'target-1');

    expect(result).toMatchObject({ verified: true, reason: 'verified' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ verified: true, verificationMethod: 'lab' });
    expect(updates[0]?.verifiedAt).toBeInstanceOf(Date);
    expect(checks.checkDnsTxt).not.toHaveBeenCalled();
    expect(checks.checkHttpWellKnown).not.toHaveBeenCalled();
  });

  it('records lab even when the person asked for the HTTP file method', async () => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', 'juice-shop.lab');
    const { service, updates } = serviceFor(pendingTarget('domain', 'juice-shop.lab'));

    await service.verifyTarget('scope-1', 'target-1', 'http_well_known');

    expect(updates[0]).toMatchObject({ verificationMethod: 'lab' });
    expect(checks.checkHttpWellKnown).not.toHaveBeenCalled();
  });

  it('leaves a host not in the list to the DNS TXT check, unverified when the record is missing', async () => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', 'juice-shop.lab');
    const { service, updates } = serviceFor(pendingTarget('domain', 'example.com'));

    const result = await service.verifyTarget('scope-1', 'target-1');

    expect(result).toMatchObject({ verified: false, reason: 'not_found' });
    expect(checks.checkDnsTxt).toHaveBeenCalledWith('example.com', expect.any(String));
    expect(updates).toHaveLength(0);
  });

  it.each([
    'api.juice-shop.lab',
    'shop.lab',
    'juice-shop.la',
    'juice-shop.lab.example.com',
  ])('matches only the exact host: %s still needs DNS or a file', async (value) => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', 'juice-shop.lab');
    const { service, updates } = serviceFor(pendingTarget('domain', value));

    const result = await service.verifyTarget('scope-1', 'target-1');

    expect(result.verified).toBe(false);
    expect(checks.checkDnsTxt).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(0);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only commas and spaces', ' , ,'],
  ])('changes nothing when the list is %s', async (_label, value) => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', value ?? '');
    if (value === undefined) delete process.env.NULL_AI_LAB_TARGETS;
    const { service, updates } = serviceFor(pendingTarget('domain', 'juice-shop.lab'));

    const result = await service.verifyTarget('scope-1', 'target-1');

    expect(result).toMatchObject({ verified: false, reason: 'not_found' });
    expect(checks.checkDnsTxt).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(0);
  });

  it('never applies to a CIDR target, even one written into the list', async () => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', '8.8.8.8/32');
    const { service, updates } = serviceFor(pendingTarget('cidr', '8.8.8.8/32'));

    const result = await service.verifyTarget('scope-1', 'target-1');

    expect(result.verified).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

describe('subdomains of a lab target', () => {
  const addTargetUnder = async (parentMethod: string) => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            { type: 'domain', value: 'juice-shop.lab', verified: true, verificationMethod: parentMethod },
          ]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: vi.fn(async () => [values]) };
        }),
      })),
    };
    await new ScopeService(db as never).addTarget('scope-1', { type: 'domain', value: 'api.juice-shop.lab' });
    return inserted[0];
  };

  it('do not inherit a lab verification: the subdomain is added unverified, to prove itself', async () => {
    vi.stubEnv('NULL_AI_LAB_TARGETS', 'juice-shop.lab');

    const row = await addTargetUnder('lab');

    expect(row).toMatchObject({ value: 'api.juice-shop.lab', verified: false, verificationMethod: 'dns_txt' });
    expect(row?.verificationToken).toEqual(expect.any(String));
  });

  it('still inherit a DNS verification, as before', async () => {
    const row = await addTargetUnder('dns_txt');

    expect(row).toMatchObject({ value: 'api.juice-shop.lab', verified: true, verificationMethod: 'none' });
  });
});

describe('NULL_AI_LAB_TARGETS parsing', () => {
  it('reads a comma list, trimming and lowercasing each host and dropping empty items', () => {
    expect([...labTargetHosts({ NULL_AI_LAB_TARGETS: ' Juice-Shop.lab , ,dvwa.lab ' })]).toEqual([
      'juice-shop.lab',
      'dvwa.lab',
    ]);
  });

  it('compares a host to the list exactly, ignoring only case and surrounding space', () => {
    const hosts = labTargetHosts({ NULL_AI_LAB_TARGETS: 'juice-shop.lab' });
    expect(isLabTarget(' JUICE-SHOP.LAB ', hosts)).toBe(true);
    expect(isLabTarget('juice-shop.lab.', hosts)).toBe(false);
    expect(isLabTarget('x.juice-shop.lab', hosts)).toBe(false);
  });
});
