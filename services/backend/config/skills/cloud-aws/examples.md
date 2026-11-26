# AWS Examples

## Named private object is public

The test tenant uploads a synthetic marker through the application. Its exact S3 object URL is then readable anonymously, while a nonexistent key returns `404` and application policy marks uploads private. Expected disposition: proof.

## Public website asset

An anonymous request reads `logo.svg` from a bucket configured and documented for static website hosting. No private prefix or listing is exposed. Expected disposition: reject as intended public content.

## IaC wildcard

Terraform grants `s3:GetObject` on `arn:aws:s3:::example-public-assets/*`; the module is active but the bucket contains only public web assets. Expected disposition: configuration observation, not a data-exposure finding.

## Discovered key

A scanner finds an AWS access-key-shaped value. Preserve a redacted hash and source location; do not call STS or any AWS API. Hand it to secret-response workflow and classify validity as blocked unless the owner supplies safe revocation evidence.
