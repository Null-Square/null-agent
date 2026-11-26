# SQL Injection Examples

## Boolean proof

Three interleaved true predicates match baseline's normalized record; three matched false predicates return a stable empty result; an inert control does not change results. Expected disposition: proof.

## Database error proof

An unmatched quote repeatedly produces a PostgreSQL syntax error naming the tested expression, while equal-length punctuation controls return normally. Expected disposition: proof with the exact pair; do not enumerate schema.

## Search-language lookalike

Words `AND` and `OR` change search results, but quote-balanced SQL predicates do not and the product documents boolean search syntax. Expected disposition: reject.

## Timing noise

Candidate and control latency overlap during 429 responses and queue saturation. Expected disposition: reject, even if one candidate reaches the requested delay.

## Blocked

The backing dataset rebuilds continuously and no normalized field is stable. Stop rather than escalating to extraction.
