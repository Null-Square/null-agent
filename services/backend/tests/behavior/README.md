# Behavior Smoke Tests

Behavior Lab has two compatible modes:

- `model-choice` keeps the existing one-turn model-in-the-loop canaries. Live calls remain
  outside `test`, `verify`, and CI because they spend model tokens.
- `assembled-runtime` uses a deterministic scripted provider, executes the shipping runtime
  boundary, inspects durable state, cold-restarts, hydrates trace artifacts, and emits a
  portable evidence bundle. Deterministic assembled gates run in CI.

Layout:

```text
tests/behavior/
  assertions.ts
  types.ts
  scenarios/
    delegation.ts
    phase.ts
    reporting.ts
    shell.ts
    validation.ts
    index.ts
  assembled/
    fixtures/tools/
    scenarios/
    DurableBehaviorStore.ts
    assembledRuntime.ts
    evidenceSchema.ts
    hydrateTrace.ts
    types.ts
  results/
```

The bootstrap in `scripts/run-behavior-smoke-tests.ts` loads local environment
configuration before dynamically starting `scripts/run-behavior-smoke-tests.lib.ts`,
which owns CLI parsing, model-family resolution, model dispatch, result
printing, and output writing. Scenario files own prompts, tool lists, and
assertions.

Default mode is a dry run with no model spend:

```powershell
npm run test:behavior -w services/backend
```

List scenarios:

```powershell
npm run test:behavior:list -w services/backend
npm run test:behavior:assembled:list -w services/backend
```

Run deterministic assembled-runtime scenarios and write
`tests/behavior/results/assembled-latest.json`:

```powershell
npm run test:behavior:assembled:run -w services/backend
```

Run the CI assertions for the E0–E9 assembled gates:

```powershell
npm run test:behavior:assembled -w services/backend
```

Run live against one model family:

```powershell
npm run test:behavior:live -w services/backend
$env:BEHAVIOR_FAMILY='moonshot'; npm run test:behavior:live -w services/backend
$env:BEHAVIOR_FAMILY='gpt'; npm run test:behavior:live -w services/backend
```

Run one scenario:

```powershell
$env:BEHAVIOR_SCENARIO='validation-open-lead-without-visible-hash'; npm run test:behavior:live -w services/backend
```

Useful environment variables:

- `BEHAVIOR_FAMILY` (`deepseek` by default; also supports `gpt`, `claude`, `moonshot`, and `qwen`)
- `BEHAVIOR_MODEL` (optional explicit override; normal use should only set family)
- `BEHAVIOR_API_KEY`
- `BEHAVIOR_API_BASE_URL`
- `BEHAVIOR_MAX_OUTPUT_TOKENS`
- `BEHAVIOR_SCENARIO` (comma-separated scenario IDs)
- `BEHAVIOR_MODE` (`model-choice` by default; set `assembled-runtime` for deterministic assembled scenarios)
- `BEHAVIOR_LIVE_CACHE` (`1` opts an assembled scenario's live probe in without `--live`)

Family selection reads `services/backend/config/seeds/models.seed.json`, so model names and base URLs stay aligned with the seeded backend models. Provider-specific keys are also accepted: `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `OPENAI_API_KEY`, `QWEN_API_KEY`, and `ANTHROPIC_API_KEY`.

`claude` uses Anthropic's native Messages API. `deepseek`, `gpt`, `moonshot`, and `qwen` use OpenAI-compatible chat completions.

Current canaries:

- `planner-active-replan-submits-once`: planner should call `submit_plan` once for an active replan request with canonical phases and reporting closeout.
- `planner-terminal-run-does-not-submit-plan`: planner should not call tools when a stale replan reaches a cancelled terminal run.
- `validation-open-lead-without-visible-hash`: model should close/block a rendered validation lead without fabricating `promptSha256`.
- `validation-confirming-evidence-closes-lead`: model should close a validation lead as `validated` when confirming observations already exist.
- `validation-durable-candidate-promotes-finding`: validation should use `promote_finding` for a durable candidate finding, not the lead-outcome tool.
- `validation-gate-unclosed-finding-submits-outcome`: model should repair an `unclosed_validation_findings` gate with `submit_validation_outcome(validated)` after confirmed reproduction, not `report_finding` or lead closeout.
- `validation-gate-unclosed-finding-allows-inconclusive-or-blocked`: model should use `submit_validation_outcome(inconclusive)` or a blocked handoff when validation cannot decide, without faking a validated finding.
- `validation-queued-finding-uses-submit-validation-outcome`: validation phase should close queued candidate findings with `submit_validation_outcome`, not the lead-outcome tool.
- `validation-promote-result-requires-finding-outcome`: model should follow `promote_finding.nextAction=submit_validation_outcome` after independent reproduction.
- `depth-raw-http-smuggling-uses-http-raw-send`: model should use `http_raw_send` for byte-exact malformed HTTP probes.
- `depth-normal-http-evidence-uses-http-payload`: model should keep ordinary HTTP evidence on `http_payload`.
- `depth-stateful-poc-uses-python-session`: model should use `python_session` for persistent replay/PoC work.
- `depth-validation-reproduced-proof-includes-replay-link`: model should close reproduced findings with 2.4C proof replay metadata.
- `depth-validation-nonreplayable-keeps-standing`: model should keep hard-to-replay true positives validated with an explicit escape reason.
- `depth-authz-idor-uses-authz-replay`: model should use `authz_replay` for systematic two-identity IDOR testing.
- `depth-blind-ssrf-mints-oob-token`: model should mint an OOB callback token before sending a blind SSRF/RCE/XXE payload.
- `depth-blind-callback-confirm-uses-oob-check`: model should poll OOB interactions for the minted token instead of guessing from an unchanged in-band response.
- `reporting-reads-assigned-methodology-before-preflight`: reporting phase should activate its assigned methodology before beginning the preflight-to-finalization sequence.
- `reporting-preflight-first`: after methodology orientation, reporting phase should call `report_finalizer_preflight` before drafting/finalizing.
- `reporting-interim-report-with-remediation-warning`: reporter should write honest interim report content when preflight blocks final mode and warns about missing remediation.
- `reporting-backfills-missing-remediation-before-draft`: reporter should backfill missing remediation with `report_finding(validatesFindingId=...)` before drafting.
- `reporting-no-findings-summary`: reporter should write an honest no-findings summary without inventing a vulnerability.
- `reporting-system-audit-uses-useful-relationship-map`: reporter should audit a multi-tier system and choose a Mermaid relationship map when it clarifies evidenced trust boundaries and a confirmed finding path, without being directly told to draw one.
- `reporting-finalize-interim-after-artifacts`: reporter should call `finalize_run_artifacts(mode="interim")` once interim artifacts and phase handoff are complete.
- `parent-executor-delegation-guidance`: parent executor should use `spawn_worker` when delegation guidance strongly recommends sidecar workers.
- `parent-executor-no-worker-tools-direct-work`: parent executor should work directly when worker tools are absent.
- `delegation-negative-sequential-local`: executor should avoid delegation for a sequential blocking probe.
- `worker-handoff-complete`: worker should submit a structured result artifact once delegated work is done.
- `worker-result-already-submitted-stops`: worker should stop without tools when its result is already recorded.
- `parent-synthesizes-existing-worker-handoff`: parent should read a completed worker handoff before creating duplicate work.
- `parent-continues-after-worker-token-limit-partial-result`: parent should synthesize a runtime partial worker result after a token safety stop instead of looping or spawning duplicate work.
- `parent-assigns-phase-compatible-worker-skill`: parent should assign a phase-compatible catalog skill to a worker even when it was not planner-assigned.
- `unknown-shell-job-recovery`: model should recover from `unknown_job_id` by using a known shell job id.
- `unknown-shell-job-no-known-ids-block`: model should submit a blocked handoff when an unknown shell job has no recoverable ids and budget is exhausted.
- `completed-shell-job-read-output`: model should read preserved stdout artifact from a completed shell job.
- `phase-repeated-gate-repair-not-retry`: model should repair a repeated gate failure instead of retrying the same blocked handoff.

Model-choice scenarios are one model request and assert first-tool behavior. They do not
execute tool calls or continue the session.

Assembled-runtime scenario
`harness-verification-gate-detects-hidden-runtime-failure` executes the production
`TurnToolExecutor -> ToolsRegistryAdapter -> ToolsRegistry` path with the real filesystem
trace recorder and a contract-faithful durable tool-execution adapter. It injects
`after_neutral_external_effect_before_tool_terminal`, disposes the live runtime, cold-starts
from persisted state, hydrates artifact-backed trace events, and reconciles messages, model
requests, attempts, tool executions, terminal state, and a neutral external counter. Its
negative control deliberately omits the authoritative execution claim; the legacy
first-tool assertion still passes while the assembled gate names the missing record and
duplicate effect.

`harness-interrupted-result-verifies-before-retry` exercises the shared recovery projection
through live repair and a serialized cold restart. Its fixtures cover explicit durable
`not_started`, started-without-terminal, and legacy no-ledger history. It validates exact
OpenAI-compatible and Anthropic result pairing, lets a deterministic provider react to the
typed outcome, and checks a neutral counter for duplicate effects. Its negative control
restores the former blind-retry text and must fail the semantic gate even though the message
ordering remains provider-valid.

`harness-host-capabilities-select-real-persistence-owner` resolves the production
organization and Research Lab capability factories, writes the same seven lifecycle facts
through contract-faithful file-backed adapters, and reconstructs both hosts from cold
state. Its negative control declares ephemeral Research Lab tool state and must be rejected
at hosted-port registration before provider or tool dispatch.

`harness-restart-does-not-duplicate-external-effect` runs the schema-v2 tool lifecycle for
organization and registered Research Lab hosts at four named fault points: after claim,
after start, after the neutral external effect, and after terminal settlement. Cold replay
must expose `not_started`, expose and persist `outcome_unknown`, or return the frozen cached
success as appropriate, while every corrected counter remains at most one. Its negative
control moves claim after the effect and must detect both the ordering violation and a
duplicated counter effect.

`harness-recorded-request-equals-provider-dispatch` runs the production model runtime and
shared provider dispatch seam for organization and registered Research Lab hosts. It
persists one provider-decorated canonical request before two durable attempts, cold-reads
the owning request ledger, and compares both captured transport envelopes with the stored
digest and content. Its negative control mutates a tool schema after persistence and must
fail the digest guard before the transport counter increments.

`harness-large-window-does-not-compact-at-eleven-percent` runs the production build stage
through all five compaction profiles with an authoritative routed-capacity measurement. A
one-million-token route remains uncompressed near the former 11 percent failure point and
compacts at its derived soft threshold. It also checks component accounting and route
invalidation. Its negative control restores a fixed 160,000-token cap and must make the
wrong compaction decision.

`harness-context-overflow-compacts-once-and-recovers` runs the production build, immutable
model-request, provider-dispatch, and durable history-transformation boundaries. A typed
first overflow commits one stable-ID transformation and dispatches one newly linked request;
cold recovery before and after activation converges on the same boundary. A second overflow
must stop at two requests, and failed partial output must remain absent from history. Its
negative control uses a mutable array-position cutoff and is rejected.

`harness-artifact-trace-survives-delayed-terminal-close` runs the schema-v3 trace recorder
through delayed S3 trace persistence with an artifact-backed marker. It proves that the
reserved correlation header stays inline, strict hydration verifies the stored-byte digest,
and terminal close waits until the accepted and persisted high-water marks agree. Its
negative controls corrupt an artifact, reject a required post-close write, and simulate a
crash before flush; each must produce an exact degraded or failed integrity result instead
of a false complete claim.

`harness-provider-retry-keeps-one-logical-request` runs the production `ModelRuntime`
retry seam with one immutable schema-v3 model request and schema-v2 provider-attempt
accounting. A deterministic transient failure settles attempt one with its normalized
error, retry decision, and backoff; attempt two succeeds and is the only response allowed
to contribute a neutral tool call. The ledger preserves uncached input, cache reads, cache
writes, output, reasoning tokens, and reasoning source independently, while trace attempt
headers and E6 reconciliation retain request/attempt identity. Its negative controls prove
that a non-retryable error stops after one dispatch and that cancellation wins over a late
provider success.

`harness-unified-tool-pipeline-preserves-decisions-and-results` runs four deterministic
model-produced tool calls through the production model, attempt, turn executor, registry,
durable tool/request, and trace boundaries. An allowed read matches an isolated legacy
result without dual dispatch; an approval-required temporary update emits once and resumes
through the exact 13-stage lifecycle; a denied tool never claims or dispatches. Every real
dispatch joins one E3 row to its E4 parent, E7 attempts and E6 trace pairs reconcile, and
post-hooks cannot mutate the frozen terminal result. Its negative control attempts to
widen deny to allow and must produce one recorded `decision_monotonicity` invariant with
zero dispatches.

`harness-read-model-reconstructs-multi-session-chain` runs the production
`RunTrajectoryService` over neutral planner, executor, and worker E3–E8 records. It
reconstructs request, ordered retry attempts, response, tool invocation, and artifact-backed
result through explicit source IDs; links an E5 source request to its replacement message;
strictly hydrates E6 artifact detail; and proves that run/session filters reuse stable IDs.
Concurrent worker siblings have accepted order opposite their timestamps, remain explicitly
unordered, and never acquire timestamp-derived causality. The negative control removes one
parent and must fail reconciliation while retaining `timestampsAreCausal=false`. The corpus
report names run/session/source-record units and applies the 15k-event, 25 MB, and 1,000 ms
numeric gates before recommending cache or deeper indexing.

`harness-trajectory-explains-retry-compaction-tool-chain` reuses that neutral E9
production projection as the runtime half of the E10 operator gate. It requires the
complete request/retry/response/tool chain, source-linked context reduction, strict
artifact hydration, and stable run/session record IDs. Its negative input remains failed
with one absent explicit parent, two unordered siblings, and no timestamp causality. The
paired admin-panel component gate owns presentation-only assertions for the typed tool
renderer, missing artifact warning without synthesis, URL/keyboard navigation, live-page
deduplication, and the 6,393-record virtual window.

`harness-3-2-assembled-restart-integrity-canary` is the deterministic E11 release gate.
It runs all twelve E0–E10 scenarios, hashes each canonical evidence object, declares the
organization and Research Lab lifecycle owners, and checks eight host/current/legacy/fault
rows plus all ten global invariants. The positive receipt requires one external effect per
host, outcome-unknown cold recovery, one converged context transaction, two joined provider
attempts, reconciled trace close, strict artifact detail, and matching complete E9/E10
chains. Its negative receipt must remain non-complete across artifact, backend trajectory,
and workspace evidence. Ten reverse controls preserve the same durable snapshot digest.
Use `npm run test:behavior:release` to write the versioned bundle consumed by CI.

`harness-3-2-conformance-cache-economics` is the cross-epic conformance and prompt-cache
gate. It is the only scenario with a live leg, and it answers what the per-epic gates
structurally cannot.

Leg A drives the shipping `DefaultBuildStage` over every route in `models.seed.json` at 1:10
scale and records which reducer engages first. It asserts that the **default** route
summarises before it truncates, and reports every route where the emergency trimmer discards
history the summariser never saw. Leg B replays consecutive turns and measures how much of
the previous request's prefix each new request can still reuse, so an ordinary turn must
classify as `append_extension` and a reducing turn must be named rather than read as an
append. Both legs are deterministic and always run.

Leg C makes eight real DeepSeek calls through the shipping `DeepSeekChatProvider` and reads
`prompt_cache_hit_tokens` back. A per-run nonce in the first token of every fixture keeps
each run cold, so the negative controls cannot be contaminated by a previous run. It proves
the E12 compaction shape keeps the warm prefix, that the pre-E12 shape keeps none of it,
that a rewrite while warm is expensive, and that the projection is only ever an upper bound
on reuse — never reported as a confirmed hit.

```powershell
npm run test:behavior:conformance -w services/backend        # deterministic, free
npm run test:behavior:conformance:live -w services/backend   # + real DeepSeek calls
```

The live leg needs `DEEPSEEK_API_KEY` and costs about one US cent. Without `--live` it
records `ran: false` with a reason, so CI stays deterministic and offline. Findings and
measured figures are in
`docs/prd/3.2/harness-3.2-conformance-verification-note.md`.

Infrastructure scheduling is intentionally outside this harness. Admission
locking, capacity ceilings, fairness, worker bursts, and teardown recovery are
covered by `npm run test:scheduling:stress`; adding them here would introduce
model variance and spend without exercising the scheduler's database/runtime
control paths. Add a Behavior Lab scenario only if a later scheduling change
alters what an agent is told to do while waiting or resuming.
