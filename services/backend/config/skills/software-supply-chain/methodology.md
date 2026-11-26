# Software Supply Chain Methodology

Use this method to assess dependency provenance, lockfile integrity, package-source configuration, build inputs, artifact attestations, and CI trust boundaries. It does not publish packages or trigger production releases.

## Preconditions and Fast Applicability

Require repository/build artifacts, ecosystem/lockfiles, authorized registry metadata access, and the intended build/release policy. Use an isolated offline build or evaluator branch when dynamic confirmation is needed.

## Surface Discovery and Prioritization

Map manifests/lockfiles, direct/transitive dependencies, registries, namespace scopes, integrity hashes, install scripts/plugins, build actions, CI identities/secrets references, artifact signing/attestation, and update automation.

## Safe Test Ladder

1. Verify manifest-lockfile consistency offline.
2. Resolve package sources and integrity from lock metadata.
3. Identify unpinned sources, mutable refs, alternate registries, and namespace gaps.
4. Review install/build scripts without executing them.
5. Reproduce dependency resolution with scripts/network disabled in an isolated workspace.
6. Verify artifact digest/attestation against the declared source revision.
7. Model one evaluator-only namespace/source confusion using local mock metadata, never a public publication.

## Variation Matrix

| Axis | Variants |
|---|---|
| ecosystem | only detected package managers |
| source | official/private registry, VCS, local artifact |
| pinning | exact digest/version, range, mutable ref |
| build | scripts disabled, isolated documented build |
| provenance | digest, signature, attestation, none |
| CI trust | fork/branch/tag/reusable workflow context |

## Proof Standard

Proof requires a reachable build/release path that can resolve an unauthorized or mutable evaluator artifact, execute an untrusted build step, or accept an artifact without required provenance, with exact configuration and isolated reproduction. A CVE/version match or hypothetical package name is not proof.

## False Positives and Benign Lookalikes

- ranges can resolve deterministically through lockfiles;
- private namespace policy can block public fallback;
- install scripts may be disabled in CI;
- mutable refs can be pinned by digest elsewhere;
- signatures can be optional for non-release artifacts;
- scanner advisories can be unreachable or disputed.

## Missing Prerequisites and Blocked Behavior

Return `blocked` without lockfiles, registry policy, CI config, artifact digest, or isolated build. Never publish a package to prove confusion. Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `file_read`, `tooling-trivy`, `tooling-semgrep`, and ecosystem-native offline metadata commands with scripts disabled. Use `tooling-gitleaks` for secret candidates, never secret validity.

## Handoffs and Duplicate Prevention

Hand source-to-runtime findings to `source-aware-whitebox`, container/IaC provenance to `iac-container-security`, and exposed secret artifacts to `information-disclosure`.

## Stop, Cleanup, and Data Minimization

Stop at one isolated provenance/resolution proof or complete policy mapping. Remove mock registry/build artifacts and retain digests/config excerpts.

Never perform destructive actions, publish public artifacts, execute unreviewed install scripts, or trigger releases.

Research date: 2026-07-23

## Sources

- SLSA Specification: https://slsa.dev/spec/
- OpenSSF Scorecard Documentation: https://scorecard.dev/
- NIST SP 800-218, Secure Software Development Framework: https://csrc.nist.gov/pubs/sp/800/218/final
