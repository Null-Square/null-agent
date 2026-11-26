# SQLMap Methodology

Prefer request-file mode:

```bash
sqlmap -r /workspace/.artifacts/request.txt --batch --risk=1 --level=2 --output-dir=/workspace/.artifacts/sqlmap
```

Do not dump data unless explicitly authorized. Capture `log`, `target.txt`, and session output under `.artifacts/sqlmap`, then call `ingest_scan_artifact(parser="sqlmap", artifactPath=".artifacts/sqlmap")`.

## B1 Existing-Package Contract

This appendix normalizes the existing package; the package-specific procedure above remains authoritative.

### Preconditions and Fast Applicability

Confirm the exact target or artifact is authorized, the package-specific input exists, and the earlier procedure's controls and quantitative limits can be met. Otherwise record not-applicable or blocked coverage.

### Surface Discovery and Prioritization

Start from durable inventory and prioritize only the surfaces named by this package. A technology, route, banner, or version string establishes inventory, not a vulnerability.

### Safe Test Ladder

Run the package's baseline first, then its smallest one-variable candidate and a matched negative control. Stop at proof, falsification, the package cap, or a missing prerequisite.

### Variation Matrix

Apply only variations justified by the observed parser, identity, state, transport, platform, or tool behavior. Change one dimension per replay and retain the invariant baseline.

### Proof Standard

Use the package-specific proof floor above. Scanner labels, generic errors, reflection, timing outliers, and source appearance remain leads unless the documented control and impact are reproduced.

### False Positives and Benign Lookalikes

Compare the candidate with a normal baseline, a syntax-neutral or nonexistent control, and any package-specific benign condition. Reject results that are equally explained by caching, rate limiting, intended public behavior, or unstable infrastructure.

### Missing Prerequisites and Blocked Behavior

Name the missing identity, state, protocol support, repository context, callback, or safe environment and the exact evidence that would unblock testing. Never convert blocked or ambiguous work into a finding.

### Tool Selection and Fallback

Use only the tools declared by this skill and prefer machine-readable, rate-bounded output. If the preferred tool is unavailable, use the package's documented fallback or stop; do not broaden permissions.

### Handoffs and Duplicate Prevention

Keep this package focused on its declared primitive. Reuse baseline and evidence identifiers when a related skill owns another protocol, platform, or final validation decision.

### Stop, Cleanup, and Data Minimization

Stop at the first sufficient proof or rejection. Remove evaluator-created state, expire callbacks, close special connections, redact secrets and personal data, and retain only the minimum reproducible evidence. Never perform destructive actions or expand beyond the authorized target.

Research date: 2026-07-23

## Sources

- Package-specific sources and references listed above.
- Locked B1 authoring and evaluation PRD: ../../../../../docs/prd/3.0/agent-skill-authoring-and-evaluation.md
