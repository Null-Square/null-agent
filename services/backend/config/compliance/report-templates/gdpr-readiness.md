# GDPR Readiness Template

Use this template only when `.artifacts/report/compliance-context.json`
contains a selected `gdpr` framework.

## Required Boundary Language

State this exact sentence near the top of the report:

GDPR readiness output is supporting evidence only and is not legal advice, a GDPR certification, a supervisory-authority opinion, a DPO opinion, or an audit attestation.

Also include the platform compliance boundary sentence when requested by the
report context:

Compliance readiness output is supporting evidence only and is not an audit attestation, certification, or auditor opinion.

## Required Sections

1. Executive readiness summary
   - Selected scope, observation period, and selected processing context when available.
   - Run-assessed counts and overall framework readiness counts separately.
   - Use backend status and outcome counts from compliance-context only.
   - Include the exact GDPR boundary sentence above.

2. Applicability and role context
   - Whether evidence indicates controller, processor, joint controller, or unclear role.
   - GDPR territorial/scope evidence and limitations.
   - If role or applicability evidence is missing, record it as a context limitation or evidence request, not as a pass.

3. Evidence basis
   - Evidence library items, integrations, public website observations, scanner evidence, inventory, artifacts, and prior findings used.
   - Do not include personal data file contents unless explicitly necessary and safe. Prefer metadata, handles, and redacted excerpts.

4. GDPR readiness matrix
   - One row or compact subsection per selected GDPR control.
   - Backend status exactly.
   - Support level exactly.
   - Latest check ID, proof obligation, evidence refs, limitations, freshness, and requests.

5. Privacy/accountability gaps
   - Missing RoPA, lawful basis, DPIA, DPA, transfer, DSR, retention, breach, DPO, or applicability evidence.

6. Security-of-processing findings
   - Technical checks that support GDPR Article 32 or Article 25 readiness.
   - Explicitly separate technical exposure from legal/privacy evidence gaps.

7. Data-subject rights and transparency
   - Notice and DSR evidence, one-month response process, identity verification, refusal, and extension evidence where present.

8. Processor and transfer readiness
   - Vendor/processor inventory, DPAs, SCCs, transfer safeguards, and limitations.

9. Breach readiness
   - Breach procedure, breach register, notification decision evidence, affected-individual communication evidence, and tabletop or incident evidence.

10. Requests and next actions
    - Agent-authored evidence requests grouped by control and priority.
    - Separate remediation items from customer/legal/DPO review items.

## Writing Rules

- Never claim GDPR compliance, GDPR certification, legal approval, DPO approval, supervisory-authority approval, regulator readiness, or audit attestation.
- Never invent a lawful basis.
- Never say a lawful basis is legally correct.
- Never say a DPIA is sufficient as a legal conclusion.
- Never say a processor agreement, DPA, SCC, or transfer safeguard is legally valid or enforceable.
- Never expose secrets or personal data in the report.
- Use "evidence supports", "not evidenced", "needs customer evidence", "needs legal/DPO review", and "readiness gap" language.
