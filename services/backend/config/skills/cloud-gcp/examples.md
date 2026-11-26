# GCP Examples

## Named private object

A synthetic document uploaded by the test tenant is readable from its exact `storage.googleapis.com` URL without application auth. A nonexistent name and known public asset are controls. Expected disposition: proof.

## Cloud Run default page

A service URL is public and returns a framework welcome page, but no protected route, data, or action is exposed. Expected disposition: inventory/reject.

## Service-account key in history

Retain the commit and redacted fingerprint, notify secret-response ownership, and never call Google token or IAM APIs. Credential validity and permissions remain untested.

## Inactive Terraform

An example module grants public invoker, but CI/deployment manifests do not reference it and the current service requires auth. Expected disposition: reject as inactive example.
