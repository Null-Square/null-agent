# Azure Examples

## Protected blob exposed anonymously

A test user creates a synthetic private document through the application. The exact blob URL returns its marker without authentication; a nonexistent blob and public-assets container establish controls. Expected disposition: proof.

## Function platform error

An Azure Functions hostname returns a verbose `401` naming the runtime, but the route requires a function key and no application data/action is reached. Expected disposition: reject as fingerprint/error only.

## Secure parameter override

Bicep defaults allow public access, but the deployed environment parameter file disables it and the named synthetic blob rejects anonymous reads. Expected disposition: reject the source lead.

## SAS evidence

A repository contains a SAS URL. Redact its query and do not use it. Establish exposure/remediation from source history; runtime permission scope remains blocked without an owner-provided safe fixture.
