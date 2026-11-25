# Contributing to NullSquare Local

Use Node.js 22.18 or later. Install from the repository root and verify the production build and backend tests.

```sh
npm ci
npm run check
```

The browser tests exercise the built app with a temporary database. Install Chromium once and run the complete local check.

```sh
npx playwright install chromium
npm run verify:local
```

The frontend lives in `services/frontend`. The backend owns persistence, evidence processing and model calls in `services/backend`. Shared UI primitives and styles live in `packages/design-tokens`; retained domain types live in `packages/contracts`. Keep fixtures synthetic and credentials outside the tree.
