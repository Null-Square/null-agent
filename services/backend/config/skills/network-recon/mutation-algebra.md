# Network Recon Mutation Algebra

Mutate discovery scope only from evidence-backed seeds:

- hostname to resolved addresses;
- address to explicitly approved TCP ports;
- port to one protocol handshake;
- TLS service to supplied SNI variants;
- responsive service to a single non-mutating banner/request;
- repeat once to reject transient reachability.

Deduplicate by address, port, transport, SNI, and fingerprint. Obey the global packet/connection cap and stop on rate limits or service instability.
