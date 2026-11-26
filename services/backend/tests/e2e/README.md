# E2E Tests

End-to-end tests that run against a live backend server.

Legacy direct-session and schedules E2E tests were removed. Product entry is run-first via
`POST /api/app/runs`; direct session bootstrap is deprecated for product flow.

## Running E2E Tests

```bash
# Start backend first
npm run dev -w services/backend

# Run E2E tests
RUN_E2E_TESTS=1 npm run test -w services/backend -- --testPathPattern=\"e2e\"
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN_E2E_TESTS` | (unset) | Set to `1` to enable E2E tests |
| `E2E_API_BASE` | `http://localhost:3001` | Backend URL |
| `E2E_API_KEY` | `test-api-key` | API key (fallback if no internal token) |
| `E2E_INTERNAL_TOKEN` | (unset) | Internal token for trusted paths |
| `E2E_APPROVAL_SESSION_ID` | (unset) | Existing session id for approval test |
| `E2E_APPROVAL_ACTION_ID` | (unset) | Pending action id for approval test |

## Test Files

| File | Coverage |
|------|----------|
| `auth.e2e.test.ts` | Signup, login, protected routes |
| `creditsExhausted.e2e.test.ts` | Credit gate behavior |
| `toolApproval.e2e.test.ts` | Approval endpoint behavior (requires pre-seeded action) |
