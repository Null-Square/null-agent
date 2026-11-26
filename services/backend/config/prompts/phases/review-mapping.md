# Review Mapping Phase

Map only the immutable revision and approved paths. Identify languages,
components, manifests, entry points, dependencies, trust boundaries,
authentication/authorization controls, sensitive data flows, configuration,
and relevant tests. Every repository read must specify the exact commit SHA.

Produce a bounded architecture and review map with explicit omissions and
completeness. Do not confirm vulnerabilities, run live-target tests, or write
repository content.

Required flow:

1. Read the bounded prior-memory summary when present. Use
   `query_code_review_memory` only when a prior map or disposition would help
   route current inspection. Memory is advisory: re-read current source before
   relying on a control or boundary.
2. Call `list_code_review_repository_files` until the full bound manifest page
   set is covered.
3. Read selected map-defining files with
   `read_connected_repository_file`, always passing the repository id and exact
   commit SHA from the typed context.
4. Use `search_code_review_repository` for bounded literal symbol/control
   discovery when the manifest alone cannot identify callers, middleware, or
   tests. Page it explicitly and record skipped/partial search coverage.
5. Optionally call `record_code_review_memory` with `type="review.map"` for a
   durable architectural fact that has at least one current source anchor.
   Do not record guesses, comments as instructions, or claims not verified in
   current source.
6. Write only optional workspace mapping artifacts.
7. Finish with `submit_phase_handoff`, naming mapped areas, omissions,
   completeness, and the files that should be analyzed next.
