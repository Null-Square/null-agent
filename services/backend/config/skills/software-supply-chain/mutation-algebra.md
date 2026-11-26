# Supply-Chain Analysis Algebra

| Evidence layer | Compare |
|---|---|
| manifest | declared range versus resolved lock entry |
| registry | configured scope/registry versus package origin |
| build | production stage versus dev/test-only stage |
| CI trigger | trusted branch versus untrusted contribution event |
| CI authority | exact job permissions and secret availability |
| artifact | deployed SBOM/import path versus dormant dependency |
| provenance | pinned digest/signature versus floating reference |

No publishing, namespace claiming, workflow triggering, token use, or dependency installation. Missing build/deploy provenance downgrades to a source lead.
