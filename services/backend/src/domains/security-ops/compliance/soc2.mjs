// Public-facing categories and evidence descriptors from the tagged application catalogue.
export const controls = [
  {
    "id": "CC1.1",
    "title": "Integrity and ethical values",
    "theme": "Control Environment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No code of conduct, ethics, disciplinary, or governance evidence was found."
  },
  {
    "id": "CC1.2",
    "title": "Board independence and oversight",
    "theme": "Control Environment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No board, governing-body, oversight, or independence evidence was found."
  },
  {
    "id": "CC1.3",
    "title": "Organizational structure, authority, and responsibility",
    "theme": "Control Environment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No org chart, role ownership, RACI, authority, or responsibility evidence was found."
  },
  {
    "id": "CC1.4",
    "title": "Competence, hiring, and retention",
    "theme": "Control Environment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No hiring, onboarding, training, performance, or retention evidence was found."
  },
  {
    "id": "CC1.5",
    "title": "Accountability for control responsibilities",
    "theme": "Control Environment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No control-owner accountability, performance, or disciplinary evidence was found."
  },
  {
    "id": "CC2.1",
    "title": "Relevant and quality information",
    "theme": "Communication and Information",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No evidence was found for how relevant control information is identified, captured, and used."
  },
  {
    "id": "CC2.2",
    "title": "Internal communication of objectives and responsibilities",
    "theme": "Communication and Information",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No internal communication, policy acknowledgement, or responsibility communication evidence was found."
  },
  {
    "id": "CC2.3",
    "title": "External communication",
    "theme": "Communication and Information",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No customer, vendor, security contact, disclosure, or external communication evidence was found."
  },
  {
    "id": "CC3.1",
    "title": "Specified objectives",
    "theme": "Risk Assessment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No system objectives, service commitments, or security objective evidence was found."
  },
  {
    "id": "CC3.2",
    "title": "Risk identification and analysis",
    "theme": "Risk Assessment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No risk assessment, risk register, threat model, or risk analysis evidence was found."
  },
  {
    "id": "CC3.3",
    "title": "Fraud risk consideration",
    "theme": "Risk Assessment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No fraud risk assessment or abuse-case evidence was found."
  },
  {
    "id": "CC3.4",
    "title": "Significant change assessment",
    "theme": "Risk Assessment",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No significant-change, business-change, infrastructure-change, or risk reassessment evidence was found."
  },
  {
    "id": "CC4.1",
    "title": "Ongoing monitoring and evaluation",
    "theme": "Monitoring",
    "supportLevel": "automated_testable",
    "missingGap": "No run digest or evaluation notes were found for ongoing monitoring.",
    "noteKeywords": [
      "monitor",
      "review",
      "validated",
      "coverage",
      "observation"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC4.2",
    "title": "Control deficiency evaluation and communication",
    "theme": "Monitoring",
    "supportLevel": "automated_testable",
    "missingGap": "No evidence was found that control deficiencies are evaluated and communicated.",
    "findingKeywords": [
      "remediation",
      "control gap",
      "deficiency"
    ],
    "noteKeywords": [
      "deficien",
      "gap",
      "remediation",
      "exception",
      "owner",
      "communicat"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC5.1",
    "title": "Control activity selection and development",
    "theme": "Control Activities",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No control design, control library, or control activity evidence was found."
  },
  {
    "id": "CC5.2",
    "title": "General technology control activities",
    "theme": "Control Activities",
    "supportLevel": "automated_testable",
    "missingGap": "No general technology control evidence was found.",
    "findingKeywords": [
      "misconfiguration",
      "hardening",
      "default configuration",
      "secret",
      "dependency",
      "vulnerab"
    ],
    "noteKeywords": [
      "technology control",
      "secure configuration",
      "baseline",
      "hardening",
      "automated control"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC5.3",
    "title": "Policies and procedures for control activities",
    "theme": "Control Activities",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No security policy, procedure, control operation, or policy acknowledgement evidence was found."
  },
  {
    "id": "CC6.1",
    "title": "Logical access control and authentication",
    "theme": "Access Control",
    "supportLevel": "automated_testable",
    "missingGap": "No authentication or access-control testing evidence was found.",
    "findingKeywords": [
      "auth",
      "authentication",
      "authorization",
      "idor",
      "jwt",
      "session",
      "access control",
      "privilege"
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
      "login",
      "session",
      "mfa",
      "permission",
      "role",
      "jwt",
      "sso"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC6.2",
    "title": "Credential and registration management",
    "theme": "Access Control",
    "supportLevel": "automated_testable",
    "missingGap": "No credential provisioning, registration, reset, or deprovisioning evidence was found.",
    "findingKeywords": [
      "credential",
      "password reset",
      "account takeover",
      "mfa",
      "registration",
      "invite"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-640",
      "CWE-798"
    ],
    "noteKeywords": [
      "credential",
      "registration",
      "password reset",
      "mfa",
      "provision",
      "deprovision",
      "invite"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC6.3",
    "title": "Access authorization, modification, and removal",
    "theme": "Access Control",
    "supportLevel": "automated_testable",
    "missingGap": "No access authorization, access review, modification, or removal evidence was found.",
    "findingKeywords": [
      "authorization",
      "idor",
      "tenant",
      "role",
      "permission",
      "deprovision",
      "access review"
    ],
    "cweIds": [
      "CWE-639",
      "CWE-862",
      "CWE-863"
    ],
    "noteKeywords": [
      "authorization",
      "role",
      "permission",
      "access review",
      "deprovision",
      "offboard"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC6.4",
    "title": "Physical access restriction",
    "theme": "Access Control",
    "supportLevel": "integration_required",
    "missingGap": "No facility, badge, datacenter, device custody, or physical access evidence was found. Cloud-hosted scopes typically satisfy this through a subservice organization SOC 2 (AWS, Azure, GCP); on-premises scopes need badge/visitor/CCTV integration evidence."
  },
  {
    "id": "CC6.5",
    "title": "Asset disposal and data removal",
    "theme": "Access Control",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No asset disposal, media sanitization, device return, or data destruction evidence was found."
  },
  {
    "id": "CC6.6",
    "title": "Protection against unauthorized access",
    "theme": "Access Control",
    "supportLevel": "automated_testable",
    "missingGap": "No least-privilege or authorization-boundary evidence was found.",
    "findingKeywords": [
      "idor",
      "authorization",
      "tenant",
      "role",
      "admin",
      "mass assignment",
      "object level"
    ],
    "cweIds": [
      "CWE-639",
      "CWE-862",
      "CWE-863",
      "CWE-915"
    ],
    "noteKeywords": [
      "authorization",
      "least privilege",
      "tenant",
      "role",
      "admin",
      "object access"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC6.7",
    "title": "Transmission security and encryption",
    "theme": "Encryption",
    "supportLevel": "automated_testable",
    "missingGap": "No TLS, HTTPS, or transport-encryption evidence was found.",
    "findingKeywords": [
      "tls",
      "ssl",
      "cleartext",
      "encryption",
      "certificate",
      "sensitive data exposure"
    ],
    "cweIds": [
      "CWE-319",
      "CWE-326",
      "CWE-327"
    ],
    "noteKeywords": [
      "tls",
      "ssl",
      "https enforced",
      "https redirect",
      "encryption",
      "certificate",
      "transport"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC6.8",
    "title": "Malicious software prevention and detection",
    "theme": "Access Control",
    "supportLevel": "automated_testable",
    "missingGap": "No malware prevention, endpoint protection, or malicious-code detection evidence was found.",
    "findingKeywords": [
      "malware",
      "malicious",
      "secret",
      "dependency",
      "supply chain",
      "package compromise"
    ],
    "noteKeywords": [
      "malware",
      "antivirus",
      "anti-virus",
      "edr",
      "endpoint protection",
      "defender"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC7.1",
    "title": "Vulnerability detection and security event identification",
    "theme": "Vulnerability Management",
    "supportLevel": "automated_testable",
    "missingGap": "No vulnerability scan, validation, or detection evidence was found.",
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
    "freshnessWindowDays": 90
  },
  {
    "id": "CC7.2",
    "title": "Asset, service, and attack-surface monitoring",
    "theme": "Monitoring",
    "supportLevel": "automated_testable",
    "missingGap": "No current asset, endpoint, service, or technology inventory evidence was found.",
    "freshnessWindowDays": 90
  },
  {
    "id": "CC7.3",
    "title": "Security event evaluation",
    "theme": "Security Operations",
    "supportLevel": "automated_testable",
    "missingGap": "No evidence was found that security events are triaged and evaluated for impact.",
    "findingKeywords": [
      "validated",
      "impact",
      "incident",
      "security event"
    ],
    "noteKeywords": [
      "security event",
      "triage",
      "severity",
      "impact",
      "evaluation",
      "incident"
    ],
    "freshnessWindowDays": 90
  },
  {
    "id": "CC7.4",
    "title": "Incident response execution",
    "theme": "Security Operations",
    "supportLevel": "integration_required",
    "missingGap": "No incident response plan, tabletop, incident ticket, or response execution evidence was found. Closed by ticketing (Jira/Linear) and SIEM integrations once available; until then, track via the customer IR runbook and post-incident review records."
  },
  {
    "id": "CC7.5",
    "title": "Incident recovery and restoration",
    "theme": "Security Operations",
    "supportLevel": "integration_required",
    "missingGap": "No recovery plan, restoration test, backup restore, post-incident review, or recovery evidence was found. Closed by cloud-backup and ticketing integrations (AWS Backup, Azure Backup, Jira/Linear) once available."
  },
  {
    "id": "CC8.1",
    "title": "Change management",
    "theme": "Change Management",
    "supportLevel": "integration_required",
    "missingGap": "No change request, code review, deployment approval, test evidence, or release record was found. Closed by GitHub branch protection + ticketing (Jira/Linear) integrations once available."
  },
  {
    "id": "CC9.1",
    "title": "Business disruption risk mitigation",
    "theme": "Risk Mitigation",
    "supportLevel": "manual_evidence_required",
    "missingGap": "No business continuity, disaster recovery, backup, or resilience test evidence was found."
  },
  {
    "id": "CC9.2",
    "title": "Vendor and business partner risk management",
    "theme": "Risk Mitigation",
    "supportLevel": "integration_required",
    "missingGap": "No vendor inventory, vendor risk review, DPA, BAA, SOC report review, or third-party risk evidence was found. Closed by vendor-inventory integration and subservice SOC report tracking once available."
  }
];
