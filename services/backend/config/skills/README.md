# SecurityOps Skill Taxonomy

Skills are executable assessment methods. Framework catalogs, workflow
contracts, and report templates are not skills.

## Naming

- `compliance-*`: framework-neutral compliance assessment methods.
- `tooling-*`: methodology for one concrete scanner or utility.
- `securityops-planning` and `security-reporting`: pentest workflow contracts
  retained for the current runtime integration.
- Other slugs: vulnerability, recon, validation, or evidence methods.

The source tree remains flat because runtime loading and workspace paths use the
stable slug `/workspace/.skills/<slug>`. Prefixes provide the repository-level
grouping without a loader migration.

## B1 Catalog Contract

- `catalog.yaml` is the active release manifest. Runtime ranking and workspace
  sync exclude disabled entries; admin diagnostics may load one only with an
  audited reason.
- Every package declares its methodology, examples, mutation treatment, and
  `fixtures/manifest.yaml`. Evaluation mode hashes every declared file and
  fixture into `versionHash`.
- `runtime-catalog.snapshot.json` carries the evaluated `versionHash` plus a
  separate hash of runtime-shipped files. Production requires this snapshot,
  verifies the runtime hash, and never reads or ships fixture contents.
- `tool-ownership.yaml` maps the live sandbox manifest to one primary owner.
  `coverage.yaml` maps the locked external coverage rows to primary skills.
- `releases/` retains the B1 release and behavioral rollback manifests.
- `reports/` contains the generated catalog, ownership, coverage, and
  evaluation evidence.

From `services/backend`, run:

```text
npm run skills:runtime-snapshot
npm run skills:runtime-snapshot:write
```

Regenerate the runtime snapshot after changing the catalog or any skill
package. Evaluation and release checks fail when the committed snapshot is
stale. The production image regenerates it before pruning fixture directories
and then exercises the runtime loader against the pruned filesystem.

## Ownership Rules

- Put framework control IDs, obligations, and recommended assessment skills in
  `src/domains/security-ops/compliance/frameworks/`.
- Put framework report templates in `config/compliance/report-templates/`.
- Keep compliance skill instructions framework-neutral and consume only the
  selected controls and obligations supplied in TARGET CONTEXT.
- Add a skill only when the assessment method is genuinely different. Do not
  fork a skill merely because another framework maps to the same method.
- Keep workflow discipline selection on the persisted run record. Never infer
  pentest versus compliance behavior from goal text or an assigned skill slug.
