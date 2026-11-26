# Agent Brain Domain

The `agent-brain` domain is the shared execution kernel for chat, planner, and executor sessions.

## Purpose

- Orchestrate model turns, tool execution, streaming, and persistence.
- Maintain session state, plans, approvals, memory, and usage.
- Expose stable ports for sandbox, storage, providers, billing, and policy.

## Layering Rules

- `domain/`: Pure business logic, no I/O or adapter imports.
- `application/`: Use cases and orchestration, depends on ports + domain.
- `ports/`: Interfaces only, no adapters or concrete implementations.
- `adapters/`: Infrastructure implementations (DB, providers, sandbox, gateway).
- `infrastructure/`: Cross-cutting concerns (telemetry, guardrails).

## Entry Points

- `services/backend/src/domains/agent-brain/application/services/SessionService.ts`
- `services/backend/src/domains/agent-brain/application/orchestration/OrchestratorAdapter.ts`
- `services/backend/src/domains/agent-brain/application/core/SessionStore.ts`
- `services/backend/src/domains/agent-brain/domain/prompts/SystemPromptBuilder.ts`
- `services/backend/src/domains/agent-brain/adapters/tools/ToolsRegistry.ts`
- `services/backend/src/domains/agent-brain/adapters/providers/ProviderFactory.ts`

## Related Docs

- `docs/backend/capsules/brain/overview.md`
- `docs/backend/capsules/brain/execution-flow.md`
- `docs/backend/capsules/brain/session.md`
- `docs/backend/capsules/brain/prompts.md`
- `docs/backend/capsules/brain/tools.md`
- `docs/backend/capsules/brain/sandbox.md`
- `docs/backend/capsules/brain/guards.md`
- `docs/backend/capsules/brain/memory.md`
- `docs/backend/capsules/brain/telemetry.md`
- `docs/backend/capsules/brain/automation.md`
