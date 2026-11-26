# Drupal Examples

## Drupal-Specific Leads and Proof

- `core.extension.yml` and a lockfile show an enabled contributed module at a vulnerable version; a public route and response fingerprint tie that module to the active deployment. Retain as a corroborated version/configuration lead, not automatic exploit proof.
- An anonymous evaluator request reads a synthetic node revision that the supplied Drupal permission matrix reserves for editors. The node UUID canary and authenticated editor control establish proof.

## Rejections

- `/user/login` and `X-Generator: Drupal` only fingerprint the platform.
- A module directory exists in source but is absent from `core.extension.yml`.
- A CVE matches the major version but not the installed patch level.

Missing active configuration, route reachability, or evaluator roles blocks confirmation. Do not install modules or alter Drupal configuration.
