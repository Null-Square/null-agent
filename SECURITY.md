# Security

Null AI runs on your computer for one person.

- **Who can use it.** The app and its API answer only on this computer (127.0.0.1), and only a browser that holds the owner key counts as you. The key is in the link Null AI prints when it starts; `npm run link` prints it again. It is kept in `~/.null-ai/owner-key`, or in the backend's own volume under Docker. Any program running as your own user account can read that file, so keep your account to yourself.
- **Where the agent's tools run.** In a sandbox container on a sealed network. It reaches the internet and the lab, never your database, the app or your computer's own services. The agent's browser runs inside the sandbox too. `docker compose` and `npm run dev` both use the sealed network; with `SANDBOX_NETWORK` unset, sandboxes would join Docker's default network without the seal, and the backend says so when it happens.
- **What it may test.** Only targets you verified: a DNS TXT record, a file on the site, or a lab target you list yourself in `NULL_AI_LAB_TARGETS`. Test only what you own or have written permission to test.
- **What leaves your computer.** Your model provider receives what the agent sends it. Out-of-band checks can use a public callback server; set `INTERACTSH_SERVER_URL` to use your own. Keys you add in the app are stored encrypted in the database.

Use synthetic or redacted data when you share a screenshot, log or issue.

Report a vulnerability privately to [null@nullsquare.net](mailto:null@nullsquare.net). Ask for a private channel before sending sensitive material. Include the commit, operating system, Docker and Node.js versions, and a minimal redacted reproduction.
