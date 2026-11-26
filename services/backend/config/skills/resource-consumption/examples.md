# Resource Consumption Examples

## Bounded amplification

A search baseline with one literal term takes 140-170 ms. A 2x nested expression takes 1.4-1.6 seconds twice, while an equal-byte literal control remains below 190 ms. Health latency is unchanged and the test stops. Expected disposition: proof of bounded controllable amplification.

## Enforced GraphQL budget

A query just above the documented complexity ceiling returns `400 complexity limit exceeded` before resolver work. Normal queries succeed. Expected disposition: reject; the control is effective.

## Shared queue blocker

An export endpoint has no visible cap, but production queue telemetry and cancellation are unavailable. Sending a larger job could affect other tenants. Expected disposition: blocked without attempting the job.

## Cold-start lookalike

The first candidate takes three seconds, but the first inert control after an idle period does too; all warm requests complete in 200 ms. Expected disposition: reject.

## Safety stop

Health latency rises 22% after the first 2x candidate. Stop immediately, do not repeat, record the threshold crossing as a safety event, and do not count it as proof.
