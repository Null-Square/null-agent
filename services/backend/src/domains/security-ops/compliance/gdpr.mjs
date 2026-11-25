// Public-facing categories and evidence descriptors from the tagged application catalogue.
export const controls = [
  {
    "id": "GDPR-SCOPE-APPLICABILITY",
    "title": "GDPR scope and applicability evidence",
    "theme": "Applicability and Accountability",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "EU/EEA establishment statement",
      "EU/EEA customer or user targeting evidence",
      "monitoring, analytics, or profile tracking description",
      "controller or processor relationship evidence"
    ],
    "missingGap": "No evidence was found explaining whether GDPR applies to this scope and why."
  },
  {
    "id": "GDPR-GOV-ACCOUNTABILITY",
    "title": "Accountability ownership and privacy governance evidence",
    "theme": "Applicability and Accountability",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "privacy governance policy",
      "control owner or RACI",
      "privacy risk register",
      "executive review or privacy program evidence"
    ],
    "missingGap": "No accountability owner, privacy governance, or demonstrability evidence was found."
  },
  {
    "id": "GDPR-GOV-DPO-ROLE",
    "title": "DPO or privacy contact applicability evidence",
    "theme": "Applicability and Accountability",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "DPO appointment record",
      "DPO non-applicability assessment",
      "privacy contact role description",
      "independence or escalation evidence where DPO exists"
    ],
    "missingGap": "No DPO appointment, non-applicability rationale, or privacy contact evidence was found."
  },
  {
    "id": "GDPR-DATA-ROPA",
    "title": "Record of processing activities evidence",
    "theme": "Processing Records and Legal Basis",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "RoPA export",
      "processing register",
      "system or data-flow inventory",
      "categories of data, recipients, transfers, retention, and security measure entries"
    ],
    "missingGap": "No RoPA or equivalent processing register was found."
  },
  {
    "id": "GDPR-DATA-CATEGORIES",
    "title": "Personal-data and special-category inventory evidence",
    "theme": "Processing Records and Legal Basis",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "data-category inventory",
      "special-category data assessment",
      "criminal-conviction data assessment",
      "data classification records"
    ],
    "missingGap": "No personal-data category or special-category assessment evidence was found."
  },
  {
    "id": "GDPR-LAW-LAWFUL-BASIS",
    "title": "Lawful basis and purpose limitation evidence",
    "theme": "Processing Records and Legal Basis",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "lawful-basis matrix",
      "purpose inventory",
      "legitimate-interest assessment",
      "consent or contract basis evidence",
      "special-category condition evidence where applicable"
    ],
    "missingGap": "No lawful-basis, purpose, or special-category condition evidence was found."
  },
  {
    "id": "GDPR-LAW-CONSENT",
    "title": "Consent capture and withdrawal evidence",
    "theme": "Processing Records and Legal Basis",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "consent language",
      "consent logs",
      "withdrawal process",
      "child consent or age-gating rationale where applicable"
    ],
    "missingGap": "No consent record, withdrawal process, or non-applicability rationale was found."
  },
  {
    "id": "GDPR-TRANS-NOTICE",
    "title": "Privacy notice and transparency evidence",
    "theme": "Transparency and Rights",
    "supportLevel": "automated_testable",
    "missingGap": "No privacy notice, transparency page, or equivalent user-facing disclosure evidence was found.",
    "noteKeywords": [
      "privacy notice",
      "privacy policy",
      "transparency",
      "data subject",
      "retention",
      "controller"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "GDPR-RIGHTS-DSR",
    "title": "Data-subject rights process evidence",
    "theme": "Transparency and Rights",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "DSAR procedure",
      "request intake form or mailbox",
      "sample request log",
      "identity verification procedure",
      "one-month response tracking",
      "refusal or extension rationale records"
    ],
    "missingGap": "No DSAR process, request log, response SLA, or identity verification evidence was found."
  },
  {
    "id": "GDPR-RIGHTS-AUTOMATED-DECISION",
    "title": "Automated decision-making and profiling evidence",
    "theme": "Transparency and Rights",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "automated-decision non-applicability assessment",
      "profiling inventory",
      "user notice text",
      "human-review process",
      "model or rules explanation evidence"
    ],
    "missingGap": "No automated-decision/profiling assessment, disclosure, or non-applicability evidence was found."
  },
  {
    "id": "GDPR-DATA-RETENTION",
    "title": "Data minimisation, retention, and deletion evidence",
    "theme": "Retention, Privacy by Design, and DPIA",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "retention schedule",
      "deletion or anonymisation procedure",
      "product data-minimisation rationale",
      "erasure workflow evidence",
      "data lifecycle diagram"
    ],
    "missingGap": "No retention, deletion, anonymisation, or data-minimisation evidence was found."
  },
  {
    "id": "GDPR-PBD-DESIGN-DEFAULT",
    "title": "Data protection by design and by default evidence",
    "theme": "Retention, Privacy by Design, and DPIA",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "privacy-by-design checklist",
      "design review",
      "product requirement or privacy review",
      "default data-sharing settings",
      "access-by-default rationale"
    ],
    "missingGap": "No privacy-by-design/default design evidence was found."
  },
  {
    "id": "GDPR-RISK-DPIA",
    "title": "DPIA and high-risk processing evidence",
    "theme": "Retention, Privacy by Design, and DPIA",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "DPIA",
      "DPIA screening questionnaire",
      "high-risk processing assessment",
      "prior consultation evidence where residual risk remains high",
      "DPIA review or update record"
    ],
    "missingGap": "No DPIA, DPIA screening, high-risk rationale, or prior consultation evidence was found."
  },
  {
    "id": "GDPR-THIRD-PROCESSORS",
    "title": "Processor, subprocessor, and DPA evidence",
    "theme": "Processors, Transfers, and Breaches",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "processor or vendor inventory",
      "DPA",
      "subprocessor list",
      "processing instructions",
      "processor due-diligence review"
    ],
    "missingGap": "No processor inventory, DPA, subprocessor, or processing instruction evidence was found."
  },
  {
    "id": "GDPR-TRANSFER-SAFEGUARDS",
    "title": "International transfer safeguards evidence",
    "theme": "Processors, Transfers, and Breaches",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "transfer inventory",
      "SCCs",
      "adequacy decision basis",
      "transfer impact assessment",
      "supplementary safeguard evidence"
    ],
    "missingGap": "No transfer inventory, SCC, adequacy, transfer-impact, or supplementary-safeguard evidence was found."
  },
  {
    "id": "GDPR-BREACH-RESPONSE",
    "title": "Personal data breach response evidence",
    "theme": "Processors, Transfers, and Breaches",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "personal data breach procedure",
      "breach register",
      "DPA notification decision tree",
      "affected-individual communication template",
      "incident tabletop"
    ],
    "missingGap": "No personal data breach procedure, breach register, notification criteria, or communication evidence was found."
  },
  {
    "id": "GDPR-SEC-PROCESSING",
    "title": "Security of processing program evidence",
    "theme": "Security of Processing",
    "supportLevel": "automated_testable",
    "missingGap": "No current technical or organisational security evidence was found for personal-data processing systems.",
    "findingKeywords": [
      "vulnerab",
      "misconfiguration",
      "exposure",
      "access control",
      "availability",
      "monitoring"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "GDPR-SEC-ACCESS-CONTROL",
    "title": "Personal-data access control evidence",
    "theme": "Security of Processing",
    "supportLevel": "automated_testable",
    "missingGap": "No access-control, role-review, or authentication evidence was found.",
    "findingKeywords": [
      "auth",
      "authorization",
      "access control",
      "idor",
      "jwt",
      "session",
      "privilege",
      "tenant"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-639",
      "CWE-862",
      "CWE-863"
    ],
    "noteKeywords": [
      "auth",
      "authorization",
      "access control",
      "permission",
      "role",
      "tenant",
      "personal data"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "GDPR-SEC-ENCRYPTION-RESILIENCE",
    "title": "Encryption, resilience, backup, and restore evidence",
    "theme": "Security of Processing",
    "supportLevel": "automated_testable",
    "missingGap": "No encryption, transport, backup, restore, or resilience evidence was found.",
    "findingKeywords": [
      "tls",
      "ssl",
      "cleartext",
      "certificate",
      "backup",
      "availability",
      "encryption"
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
      "transport",
      "encryption",
      "backup",
      "restore",
      "resilience"
    ],
    "freshnessWindowDays": 90
  }
];
