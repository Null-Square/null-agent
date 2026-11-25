// Public-facing categories and evidence descriptors from the tagged application catalogue.
export const controls = [
  {
    "id": "164.308(a)(1)",
    "title": "Security management process",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "Security Rule risk analysis",
      "risk treatment or risk management plan",
      "sanction policy",
      "system activity review evidence"
    ],
    "missingGap": "No risk analysis, risk management plan, sanction policy, or system activity review evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.308(a)(2)",
    "title": "Assigned security responsibility",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "named HIPAA security official",
      "security responsibility charter or role assignment"
    ],
    "missingGap": "No named HIPAA security official or security responsibility evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.308(a)(3)",
    "title": "Workforce security",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "workforce authorization procedure",
      "clearance procedure",
      "termination or offboarding record"
    ],
    "missingGap": "No workforce authorization, clearance, termination, or documented alternative evidence was found.",
    "implementationSpec": "addressable"
  },
  {
    "id": "164.308(a)(4)",
    "title": "Information access management",
    "theme": "Administrative",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "access authorization procedure",
      "access establishment or modification record",
      "clearinghouse isolation statement when applicable"
    ],
    "missingGap": "No access authorization, access establishment/modification, or applicable clearinghouse isolation evidence was found.",
    "implementationSpec": "mixed"
  },
  {
    "id": "164.308(a)(5)",
    "title": "Security awareness and training",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "security awareness training record",
      "malware protection procedure",
      "login monitoring or password-management evidence"
    ],
    "missingGap": "No awareness training, malware protection, login monitoring, password-management, or documented alternative evidence was found.",
    "implementationSpec": "addressable"
  },
  {
    "id": "164.308(a)(6)",
    "title": "Security incident procedures",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "security incident response procedure",
      "incident reporting workflow",
      "recent incident or tabletop record"
    ],
    "missingGap": "No security incident response or reporting procedure evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.308(a)(7)",
    "title": "Contingency plan",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "data backup plan",
      "disaster recovery plan",
      "emergency-mode operation plan",
      "test or criticality-analysis record"
    ],
    "missingGap": "No backup, disaster recovery, emergency-mode operation, test/revision, or criticality-analysis evidence was found.",
    "implementationSpec": "mixed"
  },
  {
    "id": "164.308(a)(8)",
    "title": "Evaluation",
    "theme": "Administrative",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "periodic technical and non-technical evaluation",
      "assessment report",
      "remediation tracking evidence"
    ],
    "missingGap": "No periodic technical/non-technical evaluation or remediation tracking evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.310(a)(1)",
    "title": "Facility access controls",
    "theme": "Physical",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "facility access procedure",
      "visitor or badge control evidence",
      "maintenance access record",
      "contingency facility access evidence"
    ],
    "missingGap": "No facility access control, validation, maintenance, contingency operations, or documented alternative evidence was found.",
    "implementationSpec": "addressable"
  },
  {
    "id": "164.310(b)",
    "title": "Workstation use",
    "theme": "Physical",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "workstation-use policy",
      "acceptable-use policy",
      "role/location workstation rules"
    ],
    "missingGap": "No workstation-use policy or role/location usage evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.310(c)",
    "title": "Workstation security",
    "theme": "Physical",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "workstation security policy",
      "endpoint hardening or device-management evidence"
    ],
    "missingGap": "No workstation security, endpoint hardening, or device-management evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.310(d)(1)",
    "title": "Device and media controls",
    "theme": "Physical",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "device and media disposal procedure",
      "media reuse procedure",
      "asset accountability record",
      "backup-before-movement evidence"
    ],
    "missingGap": "No device/media disposal, media reuse, accountability, backup-before-movement, or documented alternative evidence was found.",
    "implementationSpec": "mixed"
  },
  {
    "id": "164.312(a)(1)",
    "title": "Access control for ePHI systems",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No access-control testing evidence was found for ePHI-relevant systems.",
    "findingKeywords": [
      "auth",
      "authorization",
      "access control",
      "idor",
      "jwt",
      "session",
      "privilege",
      "ephi"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-639",
      "CWE-862",
      "CWE-863",
      "CWE-915"
    ],
    "noteKeywords": [
      "auth",
      "authorization",
      "access control",
      "permission",
      "role",
      "session",
      "ephi"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "required"
  },
  {
    "id": "164.312(a)(2)(i)",
    "title": "Unique user identification",
    "theme": "Technical",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "identity provider export",
      "application user list",
      "unique account identifier evidence"
    ],
    "missingGap": "No user-directory, identity-provider, or application-account evidence was found to prove unique user identification.",
    "implementationSpec": "required"
  },
  {
    "id": "164.312(a)(2)(ii)",
    "title": "Emergency access procedure",
    "theme": "Technical",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "emergency access procedure",
      "break-glass test record",
      "emergency-mode access record"
    ],
    "missingGap": "No emergency-access procedure, break-glass test, or emergency-mode access record was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.312(a)(2)(iii)",
    "title": "Automatic logoff",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No automatic logoff, idle-timeout, session-expiration, or documented alternative evidence was found.",
    "findingKeywords": [
      "session timeout",
      "session expiration",
      "idle timeout",
      "automatic logoff"
    ],
    "cweIds": [
      "CWE-613",
      "CWE-384"
    ],
    "noteKeywords": [
      "automatic logoff",
      "idle timeout",
      "session timeout",
      "session expiration",
      "inactivity"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "addressable"
  },
  {
    "id": "164.312(a)(2)(iv)",
    "title": "Encryption and decryption for stored ePHI",
    "theme": "Technical",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "database encryption evidence",
      "storage encryption evidence",
      "key-management or KMS evidence"
    ],
    "missingGap": "No database, storage, key-management, cloud-encryption, or documented alternative evidence was found for ePHI at rest.",
    "implementationSpec": "addressable"
  },
  {
    "id": "164.312(b)",
    "title": "Audit controls",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No audit-control or activity-log evidence was found.",
    "findingKeywords": [
      "audit log",
      "logging",
      "insufficient logging",
      "log bypass",
      "activity record"
    ],
    "cweIds": [
      "CWE-778",
      "CWE-223"
    ],
    "noteKeywords": [
      "audit",
      "log",
      "activity",
      "event",
      "trace",
      "monitor"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "required"
  },
  {
    "id": "164.312(c)(1)",
    "title": "Integrity protection for ePHI",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No ePHI integrity or unauthorized-modification testing evidence was found.",
    "findingKeywords": [
      "tamper",
      "integrity",
      "unauthorized modification",
      "mass assignment",
      "injection"
    ],
    "cweIds": [
      "CWE-89",
      "CWE-352",
      "CWE-434",
      "CWE-502",
      "CWE-611",
      "CWE-915"
    ],
    "noteKeywords": [
      "integrity",
      "tamper",
      "alteration",
      "unauthorized modification",
      "mutation"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "required"
  },
  {
    "id": "164.312(c)(2)",
    "title": "Mechanism to authenticate ePHI integrity",
    "theme": "Technical",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "checksum, signature, versioning, immutable log, or storage-integrity evidence"
    ],
    "missingGap": "No checksum, signing, versioning, immutable-log, storage-integrity, or documented alternative evidence was found.",
    "implementationSpec": "addressable"
  },
  {
    "id": "164.312(d)",
    "title": "Person or entity authentication",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No authentication testing evidence was found.",
    "findingKeywords": [
      "authentication",
      "login",
      "mfa",
      "jwt",
      "session",
      "credential",
      "account takeover"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-307",
      "CWE-640",
      "CWE-798"
    ],
    "noteKeywords": [
      "authentication",
      "login",
      "mfa",
      "password",
      "jwt",
      "session",
      "identity"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "required"
  },
  {
    "id": "164.312(e)(1)",
    "title": "Transmission security",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No transport-security evidence was found for ePHI transmission paths.",
    "findingKeywords": [
      "tls",
      "ssl",
      "cleartext",
      "certificate",
      "encryption",
      "transport"
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
      "encryption"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "required"
  },
  {
    "id": "164.312(e)(2)(i)",
    "title": "Transmission integrity controls",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No transmission-integrity or documented alternative evidence was found.",
    "findingKeywords": [
      "hsts",
      "transport integrity",
      "tamper",
      "downgrade",
      "certificate"
    ],
    "cweIds": [
      "CWE-345",
      "CWE-319",
      "CWE-326"
    ],
    "noteKeywords": [
      "tls",
      "integrity",
      "hsts",
      "certificate",
      "tamper",
      "transport"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "addressable"
  },
  {
    "id": "164.312(e)(2)(ii)",
    "title": "Transmission encryption",
    "theme": "Technical",
    "supportLevel": "automated_testable",
    "missingGap": "No transmission-encryption or documented alternative evidence was found.",
    "findingKeywords": [
      "cleartext",
      "tls",
      "ssl",
      "encryption",
      "certificate"
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
      "encryption",
      "certificate"
    ],
    "freshnessWindowDays": 90,
    "implementationSpec": "addressable"
  },
  {
    "id": "164.314(a)",
    "title": "Business Associate contracts and arrangements",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "Business Associate Agreement inventory",
      "executed BAA",
      "third-party handling ePHI register"
    ],
    "missingGap": "No BAA, Business Associate inventory, or third-party ePHI handling evidence was found.",
    "implementationSpec": "required"
  },
  {
    "id": "164.316",
    "title": "Policies, procedures, and documentation",
    "theme": "Organizational",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "Security Rule policies and procedures",
      "documentation retention evidence",
      "policy review and update record"
    ],
    "missingGap": "No Security Rule policy/procedure, documentation retention, availability, or update evidence was found.",
    "implementationSpec": "required"
  }
];
