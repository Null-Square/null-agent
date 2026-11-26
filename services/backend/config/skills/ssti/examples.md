# SSTI Examples

## Arithmetic proof

An email preview receives a unique marker plus an engine-specific multiplication expression. The server-generated email contains the computed nontrivial result; an escaped-delimiter control remains literal. A second preview reproduces it. Expected disposition: proof.

## Merge-tag feature

`{{first_name}}` becomes the test account's first name, exactly as the product documentation specifies. Unlisted tags remain literal and no arbitrary arithmetic is evaluated. Expected disposition: reject as intended allowlisted templating.

## Engine error only

A delimiter causes a Freemarker parse exception, but all harmless expressions remain literal and source shows strict template-data separation. Expected disposition: lead at most; an error is not expression proof.

## Delayed document render

The request returns `202`. A generated PDF later contains a computed marker and the job id ties it to the input; an inert control PDF contains literal text. Expected disposition: proof with request, job, and artifact evidence.

## Prohibited escalation

Arithmetic evaluation is confirmed. Reading an environment variable or invoking a process is unnecessary and outside the proof ladder. Stop and report the expression boundary only.
