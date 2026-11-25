// Public-facing categories and evidence descriptors from the tagged application catalogue.
export const controls = [
  {
    "id": "1.2",
    "title": "Network security controls are configured and maintained for CDE boundaries",
    "theme": "Build and Maintain Secure Network and Systems",
    "supportLevel": "automated_testable",
    "missingGap": "No CDE boundary, network-security-control, or segmentation testing evidence was found.",
    "findingKeywords": [
      "firewall",
      "segmentation",
      "open port",
      "exposed",
      "network security"
    ],
    "noteKeywords": [
      "network",
      "firewall",
      "segmentation",
      "cde",
      "open port"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "1",
    "pciDssGoal": "Build and Maintain a Secure Network and Systems",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "1.3",
    "title": "CDE inbound and outbound traffic is restricted to authorized flows",
    "theme": "Build and Maintain Secure Network and Systems",
    "supportLevel": "automated_testable",
    "missingGap": "No CDE traffic-restriction or firewall boundary evidence was found.",
    "findingKeywords": [
      "exposed",
      "open port",
      "management interface",
      "firewall"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "1",
    "pciDssGoal": "Build and Maintain a Secure Network and Systems",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "1.4",
    "title": "Trusted and untrusted network connections are controlled",
    "theme": "Build and Maintain Secure Network and Systems",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "firewall rule export",
      "cloud security group export",
      "network diagram",
      "segmentation validation record"
    ],
    "missingGap": "No firewall, cloud network, or trusted/untrusted boundary evidence was found.",
    "pciDssRequirement": "1",
    "pciDssGoal": "Build and Maintain a Secure Network and Systems",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "2.2",
    "title": "Secure configuration baselines are maintained for system components",
    "theme": "Build and Maintain Secure Network and Systems",
    "supportLevel": "automated_testable",
    "missingGap": "No secure-configuration or hardening evidence was found.",
    "findingKeywords": [
      "misconfiguration",
      "default configuration",
      "hardening",
      "insecure default"
    ],
    "noteKeywords": [
      "secure configuration",
      "hardening",
      "default",
      "baseline",
      "misconfiguration"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "2",
    "pciDssGoal": "Build and Maintain a Secure Network and Systems",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "2.3",
    "title": "Wireless and vendor-default configuration evidence is reviewed where applicable",
    "theme": "Build and Maintain Secure Network and Systems",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "wireless inventory",
      "vendor-default hardening record",
      "network device baseline",
      "configuration review record"
    ],
    "missingGap": "No wireless/default hardening evidence or documented non-applicability was found.",
    "pciDssRequirement": "2",
    "pciDssGoal": "Build and Maintain a Secure Network and Systems",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "3.2",
    "title": "Stored account data is minimized and retained only when needed",
    "theme": "Protect Account Data",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "cardholder data inventory",
      "retention schedule",
      "data flow diagram",
      "storage location attestation"
    ],
    "missingGap": "No cardholder-data inventory, retention, or storage-location evidence was found.",
    "pciDssRequirement": "3",
    "pciDssGoal": "Protect Account Data",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "chd"
  },
  {
    "id": "3.3",
    "title": "Sensitive authentication data is not retained after authorization",
    "theme": "Protect Account Data",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "SAD retention prohibition policy",
      "payment processor architecture evidence",
      "storage scan attestation",
      "data disposal evidence"
    ],
    "missingGap": "No evidence was found showing sensitive authentication data is not retained after authorization.",
    "pciDssRequirement": "3",
    "pciDssGoal": "Protect Account Data",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "sad"
  },
  {
    "id": "3.5",
    "title": "Stored PAN is rendered unreadable",
    "theme": "Protect Account Data",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "database encryption evidence",
      "tokenization design",
      "PAN masking evidence",
      "KMS or key-management evidence"
    ],
    "missingGap": "No evidence was found showing stored PAN is rendered unreadable.",
    "pciDssRequirement": "3",
    "pciDssGoal": "Protect Account Data",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "pan"
  },
  {
    "id": "3.6",
    "title": "Cryptographic keys for account data are protected",
    "theme": "Protect Account Data",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "KMS policy",
      "key access review",
      "key custody record",
      "key rotation evidence"
    ],
    "missingGap": "No key-management or key-protection evidence was found for account data.",
    "pciDssRequirement": "3",
    "pciDssGoal": "Protect Account Data",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "pan"
  },
  {
    "id": "3.7",
    "title": "Key-management processes are documented and followed",
    "theme": "Protect Account Data",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "key-management procedure",
      "rotation schedule",
      "key owner register",
      "key retirement evidence"
    ],
    "missingGap": "No documented key-management process or operation evidence was found.",
    "pciDssRequirement": "3",
    "pciDssGoal": "Protect Account Data",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "pan"
  },
  {
    "id": "4.2",
    "title": "PAN is protected with strong cryptography during transmission over open public networks",
    "theme": "Protect Account Data",
    "supportLevel": "automated_testable",
    "missingGap": "No transport cryptography evidence was found for payment-data paths.",
    "findingKeywords": [
      "cleartext",
      "tls",
      "ssl",
      "certificate",
      "weak crypto",
      "cardholder data"
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
      "cryptography"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "4",
    "pciDssGoal": "Protect Account Data",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "pan"
  },
  {
    "id": "5.2",
    "title": "Malware protection mechanisms are deployed where applicable",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "EDR/anti-malware deployment export",
      "endpoint coverage report",
      "malware exception review",
      "server protection policy"
    ],
    "missingGap": "No malware protection deployment or coverage evidence was found.",
    "pciDssRequirement": "5",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "5.3",
    "title": "Malware protection is active, current, and monitored",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "anti-malware status export",
      "EDR alerting evidence",
      "signature/update status",
      "malware event review"
    ],
    "missingGap": "No current malware protection status or monitoring evidence was found.",
    "pciDssRequirement": "5",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "5.4.1",
    "title": "Anti-phishing mechanisms are in place",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "email security configuration",
      "phishing protection policy",
      "security awareness campaign",
      "anti-phishing control export"
    ],
    "missingGap": "No anti-phishing mechanism or coverage evidence was found.",
    "pciDssRequirement": "5",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "6.2",
    "title": "Secure software development practices are maintained",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "secure SDLC policy",
      "secure coding training record",
      "code review policy",
      "developer security standard"
    ],
    "missingGap": "No secure software development process evidence was found.",
    "pciDssRequirement": "6",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "6.3",
    "title": "Security vulnerabilities are identified and remediated",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "automated_testable",
    "missingGap": "No vulnerability identification, patching, or remediation evidence was found.",
    "findingKeywords": [
      "vulnerab",
      "patch",
      "dependency",
      "injection",
      "xss",
      "rce",
      "ssrf"
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
      "secure software",
      "vulnerability",
      "patch",
      "dependency",
      "code scan"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "6",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "6.4.3",
    "title": "Payment page scripts are managed and authorized",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "automated_testable",
    "missingGap": "No payment page script inventory, authorization, or observed script evidence was found.",
    "findingKeywords": [
      "payment page",
      "script",
      "skimming",
      "unauthorized script",
      "third party"
    ],
    "noteKeywords": [
      "payment page",
      "script",
      "javascript",
      "third party",
      "skimming"
    ],
    "freshnessWindowDays": 30,
    "pciDssRequirement": "6",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "payment_page",
    "pciDssAccountData": "none"
  },
  {
    "id": "6.5",
    "title": "Changes to systems and software are managed securely",
    "theme": "Maintain a Vulnerability Management Program",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "change ticket",
      "deployment approval",
      "code review evidence",
      "change rollback procedure"
    ],
    "missingGap": "No secure change-management or deployment approval evidence was found.",
    "pciDssRequirement": "6",
    "pciDssGoal": "Maintain a Vulnerability Management Program",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "7.2",
    "title": "Access to CDE components is authorized by business need",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "automated_testable",
    "missingGap": "No least-privilege or authorization testing evidence was found.",
    "findingKeywords": [
      "authorization",
      "idor",
      "role",
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
      "role",
      "permission",
      "least privilege",
      "business need"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "7",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "7.3",
    "title": "Access privileges are reviewed and kept current",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "access review export",
      "role matrix",
      "privilege approval record",
      "terminated-user access removal evidence"
    ],
    "missingGap": "No access review, role matrix, or privilege governance evidence was found.",
    "pciDssRequirement": "7",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "8.2",
    "title": "Users are uniquely identified before access is granted",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "automated_testable",
    "missingGap": "No identity or authentication testing evidence was found.",
    "findingKeywords": [
      "authentication",
      "session",
      "jwt",
      "credential"
    ],
    "cweIds": [
      "CWE-287",
      "CWE-306",
      "CWE-384"
    ],
    "noteKeywords": [
      "authentication",
      "identity",
      "user",
      "login",
      "session"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "8",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "8.3",
    "title": "Authentication factors and password controls are enforced",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "IdP password policy",
      "authentication policy export",
      "session-control evidence",
      "account lockout evidence"
    ],
    "missingGap": "No authentication factor, password, or session-control evidence was found.",
    "pciDssRequirement": "8",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "8.4.2",
    "title": "MFA is required for access into the CDE",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "automated_testable",
    "missingGap": "No MFA evidence was found for access into the CDE.",
    "findingKeywords": [
      "mfa",
      "2fa",
      "authentication bypass",
      "weak authentication"
    ],
    "noteKeywords": [
      "mfa",
      "2fa",
      "authentication",
      "cde access"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "8",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "8.5",
    "title": "MFA systems resist replay and bypass attempts",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "MFA configuration export",
      "phishing-resistant MFA setting",
      "IdP conditional-access policy",
      "MFA bypass exception review"
    ],
    "missingGap": "No MFA configuration, conditional-access, or bypass-control evidence was found.",
    "pciDssRequirement": "8",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "9.1",
    "title": "Physical access to CDE facilities is restricted",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "facility access procedure",
      "badge access report",
      "visitor log",
      "data center attestation"
    ],
    "missingGap": "No physical access restriction or facility access evidence was found.",
    "pciDssRequirement": "9",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  },
  {
    "id": "9.2",
    "title": "Visitor and personnel access to cardholder data areas is controlled",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "visitor log",
      "escort procedure",
      "access badge review",
      "visitor badge return evidence"
    ],
    "missingGap": "No visitor or personnel physical access-control evidence was found.",
    "pciDssRequirement": "9",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  },
  {
    "id": "9.5",
    "title": "Media containing account data is secured and disposed safely",
    "theme": "Implement Strong Access Control Measures",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "media handling procedure",
      "media destruction record",
      "removable media inventory",
      "shipping or storage control evidence"
    ],
    "missingGap": "No media handling, storage, or disposal evidence was found.",
    "pciDssRequirement": "9",
    "pciDssGoal": "Implement Strong Access Control Measures",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "chd"
  },
  {
    "id": "10.2",
    "title": "Audit logs capture access and security events for CDE systems",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "SIEM source list",
      "audit log sample",
      "cloud audit logging configuration",
      "application audit event inventory"
    ],
    "missingGap": "No CDE audit logging source or event coverage evidence was found.",
    "pciDssRequirement": "10",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "10.3",
    "title": "Audit log records contain useful event detail",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "sample audit event",
      "log schema",
      "SIEM parser configuration",
      "application log format evidence"
    ],
    "missingGap": "No audit log detail, schema, or parser evidence was found.",
    "pciDssRequirement": "10",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "10.4.1.1",
    "title": "Automated audit-log review is configured for critical security events",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "SIEM detection rule",
      "automated alert workflow",
      "log review dashboard",
      "alert triage record"
    ],
    "missingGap": "No automated audit-log review, alerting, or triage evidence was found.",
    "pciDssRequirement": "10",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "customized_eligible",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "10.6",
    "title": "Time synchronization supports reliable audit trails",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "integration_required",
    "evidenceExamples": [
      "NTP configuration",
      "time synchronization policy",
      "cloud time source evidence",
      "log timestamp consistency evidence"
    ],
    "missingGap": "No time synchronization or timestamp consistency evidence was found.",
    "pciDssRequirement": "10",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "11.3.1",
    "title": "Internal vulnerability scans are performed and remediated",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "automated_testable",
    "missingGap": "No current internal vulnerability scan or coverage evidence was found.",
    "findingKeywords": [
      "vulnerab",
      "misconfiguration",
      "exposure",
      "scan"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "11",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "11.3.2",
    "title": "External vulnerability scans are available for public CDE-facing systems",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "automated_testable",
    "missingGap": "No external scan readiness evidence was found for public CDE-facing systems.",
    "findingKeywords": [
      "vulnerab",
      "external",
      "exposure",
      "public"
    ],
    "freshnessWindowDays": 90,
    "pciDssRequirement": "11",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "11.4",
    "title": "Penetration testing is performed for CDE systems and applications",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "automated_testable",
    "missingGap": "No penetration-testing or adversarial validation evidence was found.",
    "findingKeywords": [
      "validated",
      "exploit",
      "penetration",
      "authorization",
      "injection",
      "xss",
      "rce"
    ],
    "freshnessWindowDays": 365,
    "pciDssRequirement": "11",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "11.4.5",
    "title": "Segmentation controls are tested where segmentation reduces PCI scope",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "automated_testable",
    "missingGap": "No CDE segmentation testing evidence or documented non-use was found.",
    "findingKeywords": [
      "segmentation",
      "firewall",
      "network path",
      "reachability"
    ],
    "freshnessWindowDays": 365,
    "pciDssRequirement": "11",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "cde",
    "pciDssAccountData": "none"
  },
  {
    "id": "11.6.1",
    "title": "Payment page change and tamper detection is in place",
    "theme": "Regularly Monitor and Test Networks",
    "supportLevel": "automated_testable",
    "missingGap": "No payment page change/tamper detection evidence was found.",
    "findingKeywords": [
      "payment page",
      "script",
      "tamper",
      "skimming",
      "change detection"
    ],
    "noteKeywords": [
      "payment page",
      "script",
      "tamper",
      "change detection",
      "skimming"
    ],
    "freshnessWindowDays": 30,
    "pciDssRequirement": "11",
    "pciDssGoal": "Regularly Monitor and Test Networks",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "payment_page",
    "pciDssAccountData": "none"
  },
  {
    "id": "12.1",
    "title": "Information security policy is established for PCI scope",
    "theme": "Maintain an Information Security Policy",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "security policy",
      "policy approval record",
      "policy review date",
      "PCI responsibility matrix"
    ],
    "missingGap": "No PCI security policy or responsibility evidence was found.",
    "pciDssRequirement": "12",
    "pciDssGoal": "Maintain an Information Security Policy",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  },
  {
    "id": "12.3.1",
    "title": "Targeted risk analyses are performed for flexible-frequency controls",
    "theme": "Maintain an Information Security Policy",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "targeted risk analysis",
      "control frequency rationale",
      "risk owner approval",
      "review cadence evidence"
    ],
    "missingGap": "No targeted risk analysis evidence was found for flexible-frequency decisions.",
    "pciDssRequirement": "12",
    "pciDssGoal": "Maintain an Information Security Policy",
    "pciDssApproach": "customized_eligible",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  },
  {
    "id": "12.3.2",
    "title": "Customized approach controls have TRA and design evidence",
    "theme": "Maintain an Information Security Policy",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "customized approach objective mapping",
      "targeted risk analysis",
      "custom control design",
      "test evidence"
    ],
    "missingGap": "No customized approach TRA, control-design, or testing evidence was found.",
    "pciDssRequirement": "12",
    "pciDssGoal": "Maintain an Information Security Policy",
    "pciDssApproach": "customized_eligible",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  },
  {
    "id": "12.8",
    "title": "Third-party service provider risk is managed",
    "theme": "Maintain an Information Security Policy",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "TPSP inventory",
      "service provider responsibility matrix",
      "AOC or compliance evidence from provider",
      "vendor review record"
    ],
    "missingGap": "No third-party service provider inventory, responsibility, or review evidence was found.",
    "pciDssRequirement": "12",
    "pciDssGoal": "Maintain an Information Security Policy",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  },
  {
    "id": "12.10",
    "title": "Incident response plans cover payment data scenarios",
    "theme": "Maintain an Information Security Policy",
    "supportLevel": "manual_evidence_required",
    "evidenceExamples": [
      "incident response plan",
      "payment data incident playbook",
      "tabletop exercise record",
      "breach escalation workflow"
    ],
    "missingGap": "No PCI-scoped incident response plan, playbook, or exercise evidence was found.",
    "pciDssRequirement": "12",
    "pciDssGoal": "Maintain an Information Security Policy",
    "pciDssApproach": "defined",
    "pciDssSaqTypes": [
      "A",
      "A-EP",
      "B",
      "B-IP",
      "C",
      "C-VT",
      "P2PE",
      "D-Merchant",
      "D-Service Provider"
    ],
    "pciDssCdeScope": "program",
    "pciDssAccountData": "none"
  }
];
