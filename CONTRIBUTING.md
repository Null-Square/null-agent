# Contributing to Null AI

You need Node.js 22.18 or later and Docker.

```sh
npm ci
npm run dev
```

`npm run dev` starts Postgres, storage and the sandbox gateway in Docker, building the sandbox image the first time. It then migrates and seeds the database, and runs the backend and the app on this computer. The agent's sandboxes join the same sealed network as under `docker compose`. Open the link the backend prints.

Before a pull request:

```sh
npm run typecheck
npm test
```

The backend's tests include integration tests that need the dev database running.

Where things live:

- `services/backend`: the API, the agent, the sandbox control, and persistence (Postgres with Drizzle).
- `services/frontend`: the app.
- `services/sandbox`: the image the agent's tools run in.
- `packages/contracts`: shared types.
- `packages/design-tokens`: shared UI pieces and styles.

Keep fixtures synthetic and credentials out of the tree, and never commit a `.env` file.
