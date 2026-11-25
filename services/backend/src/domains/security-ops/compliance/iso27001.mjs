// Public-facing categories and evidence descriptors from the tagged application catalogue.
export const controls = [
  {
    "id": "ISO-ISMS-4",
    "title": "ISMS context and scope evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No ISMS scope, interested-party, business-context, dependency, or boundary evidence was found."
  },
  {
    "id": "ISO-ISMS-5",
    "title": "Leadership, policy, and responsibility evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No approved information security policy, leadership commitment, role, or responsibility evidence was found."
  },
  {
    "id": "ISO-ISMS-6",
    "title": "Risk assessment, treatment, and security objective evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No risk method, risk register, risk treatment plan, or security objective evidence was found."
  },
  {
    "id": "ISO-ISMS-7",
    "title": "Competence, awareness, communication, and documented information evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No competence, awareness, communication, policy acknowledgement, or document-control evidence was found."
  },
  {
    "id": "ISO-ISMS-8",
    "title": "Operational risk treatment and applicability evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No operational risk treatment record, Statement of Applicability, or control-operation evidence was found."
  },
  {
    "id": "ISO-ISMS-9",
    "title": "Monitoring, internal audit, and management review evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No monitoring review, internal audit, management review, or ISMS performance evidence was found."
  },
  {
    "id": "ISO-ISMS-10",
    "title": "Corrective action and continual improvement evidence",
    "theme": "ISMS",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No corrective action, nonconformity, exception, or continual-improvement evidence was found."
  },
  {
    "id": "ISO-A-ORG-POLICY",
    "title": "Security policy set and acknowledgement evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No security policy set, approval, review cadence, or acknowledgement evidence was found."
  },
  {
    "id": "ISO-A-ORG-ROLES",
    "title": "Security roles, responsibilities, and segregation evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No security role ownership, responsibility matrix, segregation, or escalation evidence was found."
  },
  {
    "id": "ISO-A-ORG-ASSETS",
    "title": "Asset inventory and ownership evidence",
    "theme": "Organizational",
    "supportLevel": "automated_testable",
    "missingGap": "No current asset, service, endpoint, repository, or ownership evidence was found.",
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-ORG-CLASSIFICATION",
    "title": "Information classification, handling, retention, and disposal evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No information classification, handling, retention, disposal, or sanitization evidence was found."
  },
  {
    "id": "ISO-A-ORG-ACCESS-GOV",
    "title": "Access governance and periodic review evidence",
    "theme": "Organizational",
    "supportLevel": "integration_required",
    "missingGap": "No identity provider export, access review, joiner/mover/leaver, or deprovisioning evidence was found."
  },
  {
    "id": "ISO-A-ORG-SUPPLIER",
    "title": "Supplier and cloud service risk evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No vendor inventory, supplier review, cloud subservice evidence, DPA, BAA, or third-party risk evidence was found."
  },
  {
    "id": "ISO-A-ORG-INCIDENT",
    "title": "Incident response process and lessons-learned evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No incident response plan, incident ticket, tabletop, escalation, or lessons-learned evidence was found."
  },
  {
    "id": "ISO-A-ORG-BCDR",
    "title": "Backup, continuity, and recovery evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No business continuity, disaster recovery, backup, restore-test, or resilience evidence was found."
  },
  {
    "id": "ISO-A-ORG-PRIVACY",
    "title": "Privacy and legal obligation tracking evidence",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No legal obligation register, privacy obligation, DPA, retention, or regulatory-tracking evidence was found."
  },
  {
    "id": "ISO-A-ORG-THREAT-INTEL",
    "title": "Threat intelligence and advisory intake evidence",
    "theme": "Organizational",
    "supportLevel": "integration_required",
    "missingGap": "No threat intelligence, vendor advisory, vulnerability-intake, or security advisory handling evidence was found."
  },
  {
    "id": "ISO-A-PEOPLE-SCREENING",
    "title": "Workforce screening and contractual security evidence",
    "theme": "People",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No background screening, employment security clause, contractor obligation, or HR security evidence was found."
  },
  {
    "id": "ISO-A-PEOPLE-AWARENESS",
    "title": "Security awareness and role-based training evidence",
    "theme": "People",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No security awareness, role-based training, training completion, or policy acknowledgement evidence was found."
  },
  {
    "id": "ISO-A-PEOPLE-OFFBOARDING",
    "title": "Termination, offboarding, and asset return evidence",
    "theme": "People",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No offboarding checklist, account removal, access revocation, asset return, or exit evidence was found."
  },
  {
    "id": "ISO-A-PEOPLE-REMOTE",
    "title": "Remote work and acceptable-use evidence",
    "theme": "People",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No remote work, BYOD, acceptable-use, or secure work-location evidence was found."
  },
  {
    "id": "ISO-A-PHYSICAL-FACILITY",
    "title": "Facility, datacenter, and physical access evidence",
    "theme": "Physical",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No facility access, badge, visitor, datacenter, equipment-room, or subservice physical-security evidence was found."
  },
  {
    "id": "ISO-A-PHYSICAL-EQUIPMENT",
    "title": "Equipment custody, protection, and sanitization evidence",
    "theme": "Physical",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No device custody, equipment protection, media sanitization, disposal, or asset return evidence was found."
  },
  {
    "id": "ISO-A-TECH-IAM",
    "title": "Identity, authentication, and session-control evidence",
    "theme": "Technological",
    "supportLevel": "automated_testable",
    "missingGap": "No authentication, identity, MFA, session, or access-material evidence was found.",
    "findingKeywords": [
      "authentication",
      "mfa",
      "jwt",
      "session",
      "credential",
      "password"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-307",
      "CWE-384",
      "CWE-613",
      "CWE-640",
      "CWE-798"
    ],
    "noteKeywords": [
      "authentication",
      "mfa",
      "session",
      "jwt",
      "password",
      "identity",
      "sso"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-TECH-AUTHZ",
    "title": "Authorization, least-privilege, and tenant-boundary evidence",
    "theme": "Technological",
    "supportLevel": "automated_testable",
    "missingGap": "No authorization, least-privilege, tenant-boundary, or access-control testing evidence was found.",
    "findingKeywords": [
      "authorization",
      "idor",
      "access control",
      "permission",
      "privilege",
      "tenant"
    ],
    "cweIds": [
      "CWE-639",
      "CWE-862",
      "CWE-863",
      "CWE-915"
    ],
    "noteKeywords": [
      "authorization",
      "access control",
      "permission",
      "role",
      "least privilege",
      "tenant"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-TECH-PRIVILEGED",
    "title": "Privileged and administrative access evidence",
    "theme": "Technological",
    "supportLevel": "integration_required",
    "missingGap": "No privileged access inventory, admin role export, break-glass record, or privileged access review evidence was found."
  },
  {
    "id": "ISO-A-TECH-CRYPTO",
    "title": "Cryptography, key handling, and transport protection evidence",
    "theme": "Technological",
    "supportLevel": "automated_testable",
    "missingGap": "No cryptography, key-handling, TLS, HTTPS, or transport-encryption evidence was found.",
    "findingKeywords": [
      "tls",
      "ssl",
      "cleartext",
      "certificate",
      "encryption",
      "weak crypto"
    ],
    "cweIds": [
      "CWE-319",
      "CWE-326",
      "CWE-327"
    ],
    "noteKeywords": [
      "tls",
      "ssl",
      "https",
      "certificate",
      "encryption",
      "cryptography",
      "key"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-TECH-ENDPOINT",
    "title": "Endpoint, server hardening, and malicious-code protection evidence",
    "theme": "Technological",
    "supportLevel": "integration_required",
    "missingGap": "No endpoint protection, EDR, AV, malware prevention, server hardening, or device compliance evidence was found."
  },
  {
    "id": "ISO-A-TECH-NETWORK",
    "title": "Network security, segmentation, and exposure evidence",
    "theme": "Technological",
    "supportLevel": "automated_testable",
    "missingGap": "No network exposure, segmentation, service inventory, or exposed-surface evidence was found.",
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-TECH-LOGGING",
    "title": "Logging, monitoring, alerting, and audit trail evidence",
    "theme": "Technological",
    "supportLevel": "integration_required",
    "missingGap": "No SIEM, application log, cloud audit log, alerting, monitoring, or audit-trail review evidence was found."
  },
  {
    "id": "ISO-A-TECH-VULN",
    "title": "Vulnerability detection, remediation, and retest evidence",
    "theme": "Technological",
    "supportLevel": "automated_testable",
    "missingGap": "No vulnerability scan, triage, remediation, retest, or patch evidence was found.",
    "findingKeywords": [
      "vulnerab",
      "injection",
      "xss",
      "ssrf",
      "rce",
      "secret",
      "exposure",
      "misconfiguration"
    ],
    "noteKeywords": [
      "vulnerability",
      "scan",
      "coverage",
      "patch",
      "exposure",
      "remediation",
      "retest"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-TECH-SDLC",
    "title": "Secure development and change-control evidence",
    "theme": "Technological",
    "supportLevel": "integration_required",
    "missingGap": "No secure development, code review, branch protection, CI, release, test, or change-control evidence was found."
  },
  {
    "id": "ISO-A-TECH-SUPPLYCHAIN",
    "title": "Dependency, container, secret, and package-integrity evidence",
    "theme": "Technological",
    "supportLevel": "automated_testable",
    "missingGap": "No dependency, container, package, secret, or supply-chain scanning evidence was found.",
    "findingKeywords": [
      "dependency",
      "secret",
      "supply chain",
      "code",
      "container",
      "package"
    ],
    "noteKeywords": [
      "secure development",
      "code scan",
      "dependency",
      "secret",
      "supply chain",
      "container"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "ISO-A-TECH-CLOUD",
    "title": "Cloud configuration, IAM, storage, and backup posture evidence",
    "theme": "Technological",
    "supportLevel": "integration_required",
    "missingGap": "No cloud configuration, IAM posture, storage exposure, backup, or cloud security integration evidence was found."
  },
  {
    "id": "ISO-A-TECH-DATA-PROTECTION",
    "title": "Data leakage, retention, deletion, and protection evidence",
    "theme": "Technological",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No data retention, deletion, leakage prevention, DLP, storage review, or data-protection evidence was found."
  }
];
