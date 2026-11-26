import { describe, expect, it } from 'vitest';
import {
  calibrateSeverity,
  describeCalibration,
  EVIDENCED_PROVISIONAL_CEILING,
  findReportingSeverityEscalation,
  findUnsupportedImpactClaims,
  flattenEvidenceText,
  UNEVIDENCED_PROVISIONAL_CEILING,
  VALIDATED_STATES,
} from '@/domains/security-ops/findings/severityCalibration';
import { OPEN_RISK_STATES, REPORTABLE_RISK_STATES } from '@/domains/security-ops/risks/riskLifecycle';

/**
 * D19 — in production run r1, recon saw a Grafana version string and immediately filed a
 * **Medium, CVSS 5.3** customer finding. 3.1's final judgement on the same observation was
 * **Info**, noting no unauthenticated exploitation was demonstrated. 3.2's own finding text
 * admitted the same and stayed Medium, because nothing downstream recalibrated it.
 *
 * A severity nobody validated is a claim about what we think, not what we proved.
 */
describe('provisional severity calibration', () => {
  it('caps the r1 Grafana finding at what an unvalidated observation may claim', () => {
    const calibration = calibrateSeverity({
      declaredSeverity: 'medium',
      state: 'potential',
      exploitationDemonstrated: false,
      hasProofEvidence: false,
    });

    expect(calibration.severity).toBe(UNEVIDENCED_PROVISIONAL_CEILING);
    expect(calibration.provisional).toBe(true);
    expect(calibration.ceilingApplied).toBe(true);
    // Nothing is discarded: raising it after validation is a recalculation, not a rediscovery.
    expect(calibration.declaredSeverity).toBe('medium');
  });

  it('lets a validated finding hold the severity validation gave it', () => {
    const calibration = calibrateSeverity({ declaredSeverity: 'high', state: 'confirmed' });

    expect(calibration.severity).toBe('high');
    expect(calibration.provisional).toBe(false);
    expect(calibration.ceilingApplied).toBe(false);
  });

  it('lets demonstrated exploitation carry the severity even before the state catches up', () => {
    const calibration = calibrateSeverity({
      declaredSeverity: 'critical',
      state: 'verifying',
      exploitationDemonstrated: true,
    });

    expect(calibration.severity).toBe('critical');
    expect(calibration.provisional).toBe(false);
    expect(calibration.reason).toContain('demonstrated');
  });

  it('allows a higher ceiling once evidence exists, but still short of proven', () => {
    const calibration = calibrateSeverity({
      declaredSeverity: 'critical',
      state: 'verifying',
      hasProofEvidence: true,
    });

    expect(calibration.severity).toBe(EVIDENCED_PROVISIONAL_CEILING);
    expect(calibration.provisional).toBe(true);
  });

  it('never raises a severity that was already modest', () => {
    const calibration = calibrateSeverity({ declaredSeverity: 'info', state: 'potential' });

    expect(calibration.severity).toBe('info');
    expect(calibration.ceilingApplied).toBe(false);
    expect(calibration.provisional).toBe(true);
  });

  it('treats a resolved or accepted finding as settled', () => {
    for (const state of ['resolved', 'accepted']) {
      expect(calibrateSeverity({ declaredSeverity: 'high', state }).provisional).toBe(false);
    }
  });

  it('keeps a verifying finding provisional, which is what r1 CORS actually was', () => {
    // The CORS finding stayed `verifying` and never reached confirmed. Its lifecycle state
    // was honest; only the severity claim needed the same discipline.
    const calibration = calibrateSeverity({
      declaredSeverity: 'medium',
      state: 'verifying',
      hasProofEvidence: true,
    });

    expect(calibration.provisional).toBe(true);
    expect(calibration.severity).toBe('medium');
    expect(calibration.ceilingApplied).toBe(false);
  });

  it('says plainly that a capped severity is provisional', () => {
    const capped = calibrateSeverity({ declaredSeverity: 'high', state: 'potential' });

    expect(describeCalibration(capped)).toBe('low (provisional; high claimed, awaiting validation)');
  });

  it('says nothing extra about a severity validation has settled', () => {
    const settled = calibrateSeverity({ declaredSeverity: 'high', state: 'confirmed' });

    expect(describeCalibration(settled)).toBe('high');
  });

  it('is a pure function of its inputs', () => {
    const input = { declaredSeverity: 'critical' as const, state: 'potential', hasProofEvidence: true };

    expect(calibrateSeverity(input)).toEqual(calibrateSeverity(input));
  });

  describe('D20 — reporting may not raise security judgement', () => {
    it('refuses a reporting write that raises severity', () => {
      const refusal = findReportingSeverityEscalation({
        existingSeverity: 'low',
        requestedSeverity: 'medium',
      });

      expect(refusal).toContain('cannot raise severity');
      expect(refusal).toContain('submit_validation_outcome');
    });

    it('allows a reporting write that keeps or lowers severity', () => {
      expect(findReportingSeverityEscalation({ existingSeverity: 'medium', requestedSeverity: 'medium' })).toBeNull();
      expect(findReportingSeverityEscalation({ existingSeverity: 'high', requestedSeverity: 'low' })).toBeNull();
    });

    it('does not refuse when there is nothing to compare', () => {
      expect(findReportingSeverityEscalation({ existingSeverity: null, requestedSeverity: 'high' })).toBeNull();
      expect(findReportingSeverityEscalation({ existingSeverity: 'low', requestedSeverity: undefined })).toBeNull();
      expect(findReportingSeverityEscalation({ existingSeverity: 'weird', requestedSeverity: 'high' })).toBeNull();
    });
  });

  describe('D25 — impact claims must follow the evidence', () => {
    it('catches the r1 CORS bearer-token claim', () => {
      const claims = findUnsupportedImpactClaims({
        prose: [
          'An attacker-controlled sibling subdomain can use credentials: include, and the '
          + "browser sends the victim's bearer token and session cookie.",
        ],
        evidence: ['access-control-allow-origin: https://evil.example.com'],
      });

      expect(claims.map((claim) => claim.mechanism)).toContain('bearer_token_exfiltration');
      expect(claims[0]?.refusal).toContain('origin-scoped');
    });

    it('accepts the same claim when the evidence shows the header', () => {
      const claims = findUnsupportedImpactClaims({
        prose: ["the browser sends the victim's bearer token"],
        evidence: ['GET /api/me', 'Authorization: Bearer eyJhbGciOi...'],
      });

      expect(claims.map((claim) => claim.mechanism)).not.toContain('bearer_token_exfiltration');
    });

    it('separates the cookie claim from the bearer claim', () => {
      // They are different mechanisms and need different proof; the r1 prose merged them.
      const claims = findUnsupportedImpactClaims({
        prose: ["the victim's session cookie is sent to the attacker origin"],
        evidence: ['Set-Cookie: sid=abc; SameSite=None; Secure'],
      });

      expect(claims).toEqual([]);
    });

    it('catches an account-takeover claim with no authenticated session in evidence', () => {
      const claims = findUnsupportedImpactClaims({
        prose: ['This results in full account takeover.'],
        evidence: ['404 Not Found'],
      });

      expect(claims.map((claim) => claim.mechanism)).toEqual(['account_takeover']);
    });

    it('does not second-guess a finding whose exploitation was demonstrated', () => {
      expect(findUnsupportedImpactClaims({
        prose: ['full account takeover and bearer token disclosure'],
        evidence: [],
        exploitationDemonstrated: true,
      })).toEqual([]);
    });

    it('says nothing about prose that makes no impact claim', () => {
      expect(findUnsupportedImpactClaims({
        prose: ['The endpoint reflects the Origin header without validation.'],
        evidence: [],
      })).toEqual([]);
    });
  });
});

/**
 * The ceiling decides when validation has spoken, and the risk lifecycle decides which states
 * are reportable. If those two ever disagree, the report would cap findings the product
 * already considers settled — or pass ones it does not.
 */
describe('the ceiling agrees with the risk lifecycle', () => {
  it('treats exactly the reportable states as validated', () => {
    expect([...VALIDATED_STATES].sort()).toEqual([...REPORTABLE_RISK_STATES].sort());
  });

  it('leaves every reportable state uncapped', () => {
    for (const state of REPORTABLE_RISK_STATES) {
      expect(calibrateSeverity({ declaredSeverity: 'critical', state }).ceilingApplied).toBe(false);
    }
  });

  it('caps every open state that has not been validated', () => {
    for (const state of OPEN_RISK_STATES.filter((entry) => !VALIDATED_STATES.has(entry))) {
      expect(calibrateSeverity({ declaredSeverity: 'critical', state }).provisional).toBe(true);
    }
  });
});

/**
 * Evidence is a captured HTTP exchange far more often than it is prose. Reading it as JSON put
 * `"authorization":"Bearer ..."` in front of a check looking for `authorization: bearer`, so a
 * finding carrying exactly the proof it needed was accused of claiming more than it showed.
 */
describe('structured evidence reads as the text the checks expect', () => {
  it('renders a captured exchange as header lines', () => {
    const text = flattenEvidenceText({ request: { headers: { authorization: 'Bearer eyJ' } } });

    expect(text.toLowerCase()).toContain('authorization: bearer');
  });

  it('supports a bearer claim that the exchange actually shows', () => {
    const claims = findUnsupportedImpactClaims({
      prose: ['The victim bearer token is sent to the attacker origin.'],
      evidence: [flattenEvidenceText({ request: { headers: { Authorization: 'Bearer eyJhbGciOi' } } })],
    });

    expect(claims).toEqual([]);
  });

  it('still refuses the claim when the exchange shows no such header', () => {
    const claims = findUnsupportedImpactClaims({
      prose: ['The victim bearer token is sent to the attacker origin.'],
      evidence: [flattenEvidenceText({
        response: { headers: { 'access-control-allow-origin': 'https://evil.example' } },
      })],
    });

    expect(claims.map((claim) => claim.mechanism)).toEqual(['bearer_token_exfiltration']);
  });

  it('walks arrays and stops rather than recursing without bound', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(() => flattenEvidenceText(deep)).not.toThrow();
    expect(flattenEvidenceText([{ a: 1 }, { b: 'two' }])).toContain('b: two');
  });
});
