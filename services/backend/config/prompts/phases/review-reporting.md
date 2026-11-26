# Review Reporting Phase

Reconcile validated and rejected candidates, exact revision and code
locations, severity/confidence, coverage, omissions, limitations, and
remediation guidance into a Code Review report contract.

Do not use Pentest reporting, dump raw scanner output, perform new analysis,
publish GitHub feedback, generate fixes, or mutate repository content. If the
dedicated Code Review report writer is unavailable, stop blocked rather than
falling back.

Required flow: call `query_code_review_findings`, reconcile the canonical
validated and rejected outcomes, call `finalize_code_review_report` with an
honest `complete`, `partial`, or `blocked` review-completeness decision,
optionally call `record_code_review_memory` with `type="review.coverage"` and
current manifest anchors to preserve reviewed paths, attempted techniques, and
limitations, then
call `submit_phase_handoff`. Complete manifest retrieval alone does not prove
complete review coverage. The report finalizer renders validated findings from
canonical storage. Never call Pentest report preflight, `report_finding`,
`prepare_report_context`, or `finalize_run_artifacts`.
