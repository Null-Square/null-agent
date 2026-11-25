// CSF 2.0 categories and evidence descriptions from the application catalogue.
export const controls = [
  {
    "id": "GV.OC",
    "title": "Organizational context evidence",
    "theme": "Govern",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "business and mission context",
      "stakeholder and dependency register",
      "cybersecurity scope boundary"
    ],
    "missingGap": "No business context, stakeholder, dependency, or mission-impact evidence was found."
  },
  {
    "id": "GV.RM",
    "title": "Risk management strategy evidence",
    "theme": "Govern",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "risk management strategy",
      "risk appetite or tolerance statement",
      "risk prioritization criteria"
    ],
    "missingGap": "No risk appetite, risk strategy, or risk prioritization evidence was found."
  },
  {
    "id": "GV.RR",
    "title": "Roles and responsibilities evidence",
    "theme": "Govern",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "security responsibility matrix",
      "named control owners",
      "escalation and authority records"
    ],
    "missingGap": "No role, responsibility, authority, or escalation evidence was found."
  },
  {
    "id": "GV.PO",
    "title": "Cybersecurity policy evidence",
    "theme": "Govern",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "approved cybersecurity policies",
      "policy review history",
      "exception or acknowledgement records"
    ],
    "missingGap": "No cybersecurity policy, standard, exception, or approval evidence was found."
  },
  {
    "id": "GV.OV",
    "title": "Governance oversight evidence",
    "theme": "Govern",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "management or board security review",
      "control monitoring results",
      "governance action tracking"
    ],
    "missingGap": "No governance review, control monitoring, or management oversight evidence was found."
  },
  {
    "id": "GV.SC",
    "title": "Cybersecurity supply chain risk evidence",
    "theme": "Govern",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "vendor inventory and risk reviews",
      "repository or dependency controls",
      "supplier monitoring records"
    ],
    "missingGap": "No vendor-risk, repository-control, dependency, third-party, or supply-chain integration evidence was found."
  },
  {
    "id": "ID.AM",
    "title": "Asset management technical evidence",
    "theme": "Identify",
    "supportLevel": "automated_testable",
    "missingGap": "No current asset, service, endpoint, or exposure inventory evidence was found.",
    "freshnessWindowDays": 90
  },
  {
    "id": "ID.RA",
    "title": "Cybersecurity risk assessment technical evidence",
    "theme": "Identify",
    "supportLevel": "automated_testable",
    "missingGap": "No current cybersecurity risk assessment or vulnerability testing evidence was found.",
    "findingKeywords": [
      "vulnerab",
      "risk",
      "injection",
      "xss",
      "ssrf",
      "rce",
      "secret",
      "exposure",
      "misconfiguration"
    ],
    "cweIds": [
      "CWE-79",
      "CWE-89",
      "CWE-94",
      "CWE-200",
      "CWE-502",
      "CWE-918"
    ],
    "noteKeywords": [
      "risk",
      "vulnerability",
      "scan",
      "coverage",
      "exposure",
      "impact",
      "likelihood"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "ID.IM",
    "title": "Improvement evidence",
    "theme": "Identify",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "lessons-learned record",
      "improvement backlog",
      "completed corrective action evidence"
    ],
    "missingGap": "No lessons-learned, improvement backlog, or control-improvement evidence was found."
  },
  {
    "id": "PR.AA",
    "title": "Identity, authentication, and access-control evidence",
    "theme": "Protect",
    "supportLevel": "automated_testable",
    "missingGap": "No identity, authentication, or access-control testing evidence was found.",
    "findingKeywords": [
      "authentication",
      "authorization",
      "access control",
      "idor",
      "jwt",
      "session",
      "credential"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-307",
      "CWE-384",
      "CWE-613",
      "CWE-639",
      "CWE-640",
      "CWE-798",
      "CWE-862",
      "CWE-863",
      "CWE-915"
    ],
    "noteKeywords": [
      "authentication",
      "authorization",
      "access control",
      "mfa",
      "password",
      "session",
      "identity"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "PR.AT",
    "title": "Awareness and training evidence",
    "theme": "Protect",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "security awareness plan",
      "role-based training records",
      "training completion evidence"
    ],
    "missingGap": "No security awareness, role-based training, or training completion evidence was found."
  },
  {
    "id": "PR.DS",
    "title": "Data security and encryption evidence",
    "theme": "Protect",
    "supportLevel": "automated_testable",
    "missingGap": "No data-security, cryptography, or transport-protection evidence was found.",
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
      "transport"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "PR.PS",
    "title": "Platform security and hardening evidence",
    "theme": "Protect",
    "supportLevel": "automated_testable",
    "missingGap": "No platform-security, hardening, dependency, or secret-scanning evidence was found.",
    "findingKeywords": [
      "misconfiguration",
      "hardening",
      "default configuration",
      "insecure default",
      "dependency",
      "secret"
    ],
    "noteKeywords": [
      "secure configuration",
      "hardening",
      "baseline",
      "default",
      "misconfiguration",
      "dependency",
      "secret"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "PR.IR",
    "title": "Technology infrastructure resilience evidence",
    "theme": "Protect",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "backup and recovery architecture",
      "restore or failover test",
      "resilience limitation or exception"
    ],
    "missingGap": "No backup, restore-test, redundancy, failover, or recovery integration evidence was found."
  },
  {
    "id": "DE.CM",
    "title": "Continuous monitoring technical evidence",
    "theme": "Detect",
    "supportLevel": "automated_testable",
    "missingGap": "No continuous-monitoring, scan-coverage, or detection evidence was found.",
    "findingKeywords": [
      "monitoring",
      "logging",
      "detection",
      "visibility",
      "alert"
    ],
    "noteKeywords": [
      "monitor",
      "scan",
      "coverage",
      "alert",
      "log",
      "event",
      "detection"
    ],
    "freshnessWindowDays": 30
  },
  {
    "id": "DE.AE",
    "title": "Adverse event analysis evidence",
    "theme": "Detect",
    "supportLevel": "automated_testable",
    "missingGap": "No adverse-event analysis or validated-finding analysis evidence was found.",
    "findingKeywords": [
      "validated",
      "impact",
      "root cause",
      "analysis",
      "exploit",
      "attack path"
    ],
    "noteKeywords": [
      "analysis",
      "event",
      "finding",
      "root cause",
      "impact",
      "validation"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "RS.MA",
    "title": "Incident management evidence",
    "theme": "Respond",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "incident intake and severity procedure",
      "incident ticket or exercise",
      "response ownership record"
    ],
    "missingGap": "No incident intake, triage, severity, or response coordination evidence was found."
  },
  {
    "id": "RS.AN",
    "title": "Incident analysis technical evidence",
    "theme": "Respond",
    "supportLevel": "automated_testable",
    "missingGap": "No incident-analysis or validated-finding triage evidence was found.",
    "findingKeywords": [
      "validated",
      "root cause",
      "impact",
      "analysis",
      "triage",
      "remediation"
    ],
    "noteKeywords": [
      "incident analysis",
      "analysis",
      "triage",
      "root cause",
      "finding",
      "validation"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "RS.CO",
    "title": "Incident response communication evidence",
    "theme": "Respond",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "incident communication plan",
      "stakeholder notification record",
      "regulatory or customer communication criteria"
    ],
    "missingGap": "No internal, external, regulatory, or customer incident-communication evidence was found."
  },
  {
    "id": "RS.MI",
    "title": "Incident mitigation and remediation evidence",
    "theme": "Respond",
    "supportLevel": "automated_testable",
    "missingGap": "No mitigation, remediation, or retest evidence was found.",
    "findingKeywords": [
      "mitigation",
      "remediation",
      "resolved",
      "validated",
      "fix",
      "patch"
    ],
    "noteKeywords": [
      "mitigation",
      "remediation",
      "retest",
      "validated",
      "resolved",
      "fix"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "RC.RP",
    "title": "Recovery plan execution evidence",
    "theme": "Recover",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "recovery plan",
      "restore or continuity exercise result",
      "recovery objective and owner"
    ],
    "missingGap": "No recovery plan, restore test, continuity exercise, or recovery execution evidence was found."
  },
  {
    "id": "RC.CO",
    "title": "Recovery communication evidence",
    "theme": "Recover",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "recovery communication plan",
      "stakeholder update record",
      "post-recovery notification evidence"
    ],
    "missingGap": "No recovery communication, stakeholder update, or post-recovery notification evidence was found."
  }
];
