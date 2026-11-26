Contract Tests
==============

Location: `src/__tests__/contracts/`

Suites:
- `health.contract.test.ts` – `/health`/`/readiness` basic responses.
- `auth.contract.test.ts` – signup/login/me/signout happy paths + validation errors.
- `profile.contract.test.ts` – profile CRUD, onboarding status, subscription fetch/error paths.
- `admin.contract.test.ts` – admin authz (403 for non-admin) and users listing happy path (mocks).

Harness:
- `helpers/testAppHarness.ts` builds a minimal `AppContext` and Express server for contract tests.
- Tests mock auth middleware and downstream services to avoid real DB/FS dependencies.

Run:
```bash
cd services/backend
npm test -- --testPathPattern="contract"
```
