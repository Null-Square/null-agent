# Network Reconnaissance Methodology

This skill inventories reachable in-scope hosts, ports, protocols, and service fingerprints. It does not authenticate to services, run vulnerability scripts, or test exposed data.

## Preconditions and Fast Applicability

Require an exact authorized target list in CIDR, address, or hostname form; exclusions; source address restrictions; allowed protocol/port ranges; and rate/concurrency limits. Resolve every hostname before scanning and reject addresses outside the verified scope.

Default external cap is 100 packets per second, 20 concurrent connection attempts, TCP only, and the explicitly supplied port range. UDP, OS detection, raw-packet scanning, and intrusive service probes require separate authorization.

## Surface Discovery and Prioritization

1. Expand and validate the target list without network traffic where possible.
2. Perform bounded host discovery only when authorized.
3. Scan the approved TCP ports.
4. Run low-intensity version detection on confirmed open ports, excluding devices or services where probes can cause side effects.
5. Confirm HTTP/TLS services with protocol-native handshakes.
6. Record certificate names only when they are in scope or as unverified scope candidates.

Prioritize public services and nonstandard HTTP/TLS ports. A discovered private or third-party address is not automatically added to scope.

## Safe Test Ladder

1. List the resolved targets and compare them with scope.
2. Run a small common-port sample against one target to validate rate and logging.
3. Expand to the approved port set.
4. Recheck each open result once using a protocol-appropriate handshake.
5. Run bounded version detection at low intensity.
6. Capture TLS certificate and protocol negotiation where applicable.
7. Normalize service records and hand them to mapping skills.

Do not send application commands to database, cache, mail, printer, industrial, or management protocols. An open connection is sufficient inventory evidence.

## Variation Matrix

| Axis | Controlled variants |
|---|---|
| target | exact authorized host/address |
| discovery | list-only, authorized host discovery, direct port scan |
| ports | approved common set, approved explicit range |
| protocol | TCP; UDP only with explicit rule |
| confirmation | TCP state, TLS handshake, HTTP metadata, low-intensity version probe |
| result state | open, closed, filtered, open-or-filtered |

Do not treat filtered and open-or-filtered as confirmed services.

## Proof Standard

A service inventory row requires:

- target and resolved address;
- port and transport;
- scan time and source;
- raw state evidence;
- one corroborating handshake for an open result when safe;
- service/product confidence with provenance; and
- scope status.

A banner or version match is inventory only. It cannot create a vulnerability finding without class-specific behavior and proof.

## False Positives and Benign Lookalikes

- load balancers can expose the same port across changing backends;
- transparent proxies can answer on behalf of a target;
- SYN-ACK observation can be stale or spoofed in captured data;
- version probes can misclassify custom services;
- TLS SNI can change the service reached on one address;
- port-knocking and allowlists can make results source-dependent.

Corroborate once and retain confidence rather than overclaiming product identity.

## Missing Prerequisites and Blocked Behavior

Return partial coverage when target ownership, exclusions, a required protocol, rate permission, or egress path is unclear. Name the exact addresses/ports not scanned and the rules-of-engagement decision needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `tooling-naabu` for bounded TCP discovery and `tooling-nmap` for narrow service confirmation, both with machine-readable output. Use `tooling-httpx` for HTTP/TLS confirmation. Raw socket or Python fallbacks must preserve the same target, rate, and port caps.

Never enable broad script categories, evasion, spoofing, or all-port version probing by default.

## Handoffs and Duplicate Prevention

- Hand web services to `broad-surface-scan` or `api-enumeration`.
- Hand TLS configuration to `tooling-tls`.
- Hand DNS names requiring scope confirmation to `broad-surface-scan`.
- Hand technology-specific validation to its platform or vulnerability skill.

This skill owns host/port/service inventory, not vulnerabilities inferred from versions.

## Stop, Cleanup, and Data Minimization

Stop at the target/rate cap, on unexpected device behavior, or when scope resolution changes. Close connections and retain structured port records and redacted banners. Do not retain unrelated certificate subject data.

Never perform destructive actions, authenticate to discovered services, or probe addresses not in the verified target list.

Research date: 2026-07-23

## Sources

- Nmap Reference Guide: https://nmap.org/book/man.html
- Nmap Host Discovery: https://nmap.org/book/man-host-discovery.html
- Nmap Service and Version Detection: https://nmap.org/book/man-version-detection.html
- OWASP WSTG, Attack Surface Identification: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/04-Attack_Surface_Identification
