import { describe, expect, it } from 'vitest';

import {
  classifyApplicability,
  deriveAffectedRanges,
  normalizeNvdAdvisory,
  parseCpeCriteria,
  type NvdCve,
} from '@/domains/security-ops/advisories/nvdNormalizer';

/** A plain "these versions of this product are affected" advisory. */
const simpleCve: NvdCve = {
  id: 'CVE-2026-1000',
  published: '2026-02-01T00:00:00.000',
  lastModified: '2026-02-05T00:00:00.000',
  vulnStatus: 'Analyzed',
  descriptions: [{ lang: 'en', value: 'A flaw in Example Server. Remote attackers may do things.' }],
  metrics: {
    cvssMetricV31: [
      {
        cvssData: {
          baseScore: 9.8,
          baseSeverity: 'CRITICAL',
          vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        },
      },
    ],
  },
  weaknesses: [{ description: [{ lang: 'en', value: 'CWE-79' }] }],
  configurations: [
    {
      nodes: [
        {
          operator: 'OR',
          negate: false,
          cpeMatch: [
            {
              vulnerable: true,
              criteria: 'cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*',
              versionStartIncluding: '1.0.0',
              versionEndExcluding: '1.18.1',
            },
          ],
        },
      ],
    },
  ],
};

describe('classifyApplicability', () => {
  it('classifies a plain OR list of vulnerable products as simple', () => {
    expect(classifyApplicability(simpleCve)).toBe('simple');
  });

  it('classifies a configuration-level AND as complex', () => {
    // "product X, but only when running on platform Y". Flattening this would
    // alert every X user regardless of platform.
    expect(
      classifyApplicability({
        ...simpleCve,
        configurations: [{ operator: 'AND', nodes: simpleCve.configurations![0]!.nodes }],
      }),
    ).toBe('complex');
  });

  it('classifies a node-level AND as complex', () => {
    expect(
      classifyApplicability({
        ...simpleCve,
        configurations: [{ nodes: [{ operator: 'AND', cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:v:p:*:*:*:*:*:*:*:*' }] }] }],
      }),
    ).toBe('complex');
  });

  it('classifies a negated node as complex', () => {
    expect(
      classifyApplicability({
        ...simpleCve,
        configurations: [{ nodes: [{ operator: 'OR', negate: true, cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:v:p:1.0:*:*:*:*:*:*:*' }] }] }],
      }),
    ).toBe('complex');
  });

  it('classifies a vulnerable:false exception as complex', () => {
    // These carve exceptions out of the affected set; honouring them needs the
    // tree evaluated, so we refuse to auto-match.
    expect(
      classifyApplicability({
        ...simpleCve,
        configurations: [
          {
            nodes: [
              {
                operator: 'OR',
                cpeMatch: [
                  { vulnerable: true, criteria: 'cpe:2.3:a:v:p:*:*:*:*:*:*:*:*', versionEndExcluding: '2.0' },
                  { vulnerable: false, criteria: 'cpe:2.3:o:v:os:*:*:*:*:*:*:*:*' },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe('complex');
  });

  it('classifies a missing or empty configuration as absent', () => {
    expect(classifyApplicability({ ...simpleCve, configurations: [] })).toBe('absent');
    expect(classifyApplicability({ ...simpleCve, configurations: undefined })).toBe('absent');
    expect(classifyApplicability({ ...simpleCve, configurations: [{ nodes: [] }] })).toBe('absent');
  });
});

describe('parseCpeCriteria', () => {
  it('extracts vendor and product', () => {
    expect(parseCpeCriteria('cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*')).toEqual({
      componentKey: 'cpe:f5:nginx',
      pinnedVersion: null,
    });
  });

  it('reports a pinned version', () => {
    expect(parseCpeCriteria('cpe:2.3:a:apache:http_server:2.4.52:*:*:*:*:*:*:*')).toEqual({
      componentKey: 'cpe:apache:http_server',
      pinnedVersion: '2.4.52',
    });
  });

  it('refuses malformed or wildcard-vendor criteria', () => {
    // A half-parsed CPE is how you match a different project's advisories.
    expect(parseCpeCriteria('cpe:2.3:a')).toBeNull();
    expect(parseCpeCriteria('not-a-cpe')).toBeNull();
    expect(parseCpeCriteria('cpe:2.3:a:*:nginx:*:*:*:*:*:*:*:*')).toBeNull();
  });
});

describe('deriveAffectedRanges', () => {
  it('derives a bounded range with correct inclusivity', () => {
    expect(deriveAffectedRanges(simpleCve)).toEqual([
      expect.objectContaining({
        ecosystem: 'cpe',
        componentKey: 'cpe:f5:nginx',
        versionScheme: 'cpe',
        introducedVersion: '1.0.0',
        introducedInclusive: true,
        fixedVersion: '1.18.1',
        fixedInclusive: false,
      }),
    ]);
  });

  it('distinguishes inclusive from exclusive end bounds', () => {
    const [range] = deriveAffectedRanges({
      ...simpleCve,
      configurations: [
        {
          nodes: [
            {
              operator: 'OR',
              cpeMatch: [
                {
                  vulnerable: true,
                  criteria: 'cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*',
                  versionEndIncluding: '1.18.0',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(range).toMatchObject({ fixedVersion: '1.18.0', fixedInclusive: true });
  });

  it('treats a pinned criteria version as an exact match', () => {
    const [range] = deriveAffectedRanges({
      ...simpleCve,
      configurations: [
        {
          nodes: [
            {
              operator: 'OR',
              cpeMatch: [
                { vulnerable: true, criteria: 'cpe:2.3:a:apache:http_server:2.4.52:*:*:*:*:*:*:*' },
              ],
            },
          ],
        },
      ],
    });
    expect(range).toMatchObject({
      componentKey: 'cpe:apache:http_server',
      introducedVersion: '2.4.52',
      introducedInclusive: true,
      fixedVersion: '2.4.52',
      fixedInclusive: true,
    });
  });

  it('refuses an unbounded wildcard with no range fields', () => {
    // "every version ever released" is not a claim worth inferring.
    expect(
      deriveAffectedRanges({
        ...simpleCve,
        configurations: [
          {
            nodes: [
              { operator: 'OR', cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*' }] },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('produces nothing for a complex advisory', () => {
    expect(
      deriveAffectedRanges({
        ...simpleCve,
        configurations: [{ operator: 'AND', nodes: simpleCve.configurations![0]!.nodes }],
      }),
    ).toEqual([]);
  });

  it('deduplicates identical ranges', () => {
    const match = {
      vulnerable: true,
      criteria: 'cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*',
      versionEndExcluding: '1.18.1',
    };
    expect(
      deriveAffectedRanges({
        ...simpleCve,
        configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [match, { ...match }] }] }],
      }),
    ).toHaveLength(1);
  });
});

describe('normalizeNvdAdvisory', () => {
  it('normalizes the fields the matcher and alerting need', () => {
    expect(normalizeNvdAdvisory(simpleCve)).toMatchObject({
      canonicalId: 'CVE-2026-1000',
      cveId: 'CVE-2026-1000',
      severity: 'critical',
      cvssV31Score: 9.8,
      cweIds: ['CWE-79'],
      applicability: 'simple',
      state: 'active',
    });
  });

  it('marks rejected advisories withdrawn so open matches can be resolved', () => {
    expect(normalizeNvdAdvisory({ ...simpleCve, vulnStatus: 'Rejected' })?.state).toBe('withdrawn');
    expect(normalizeNvdAdvisory({ ...simpleCve, vulnStatus: 'Disputed' })?.state).toBe('disputed');
  });

  it('returns null without an id or a usable modification timestamp', () => {
    expect(normalizeNvdAdvisory({ ...simpleCve, id: undefined })).toBeNull();
    expect(normalizeNvdAdvisory({ ...simpleCve, lastModified: 'not-a-date' })).toBeNull();
  });
});
