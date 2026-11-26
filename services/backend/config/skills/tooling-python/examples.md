# Python Tooling Examples

## Good Harnesses

- Parse two captured responses and assert only the expected object-canary field differs.
- Generate a bounded Cartesian set of method/content-type variants with an explicit maximum.
- Hash and redact evidence artifacts without altering originals.

## Bad Harnesses

- An unbounded crawler, password loop, or concurrency flood.
- A script that follows redirects to arbitrary hosts.
- Code that reads ambient credentials, home-directory files, or cloud metadata.

Pin dependencies, set connect/read timeouts, enforce target allowlists, write no target state unless the case requires a disposable action, and emit a machine-readable request ledger. Python automates an approved method; it does not create scope.
