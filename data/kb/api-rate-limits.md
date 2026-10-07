---
title: API rate limits
tags: api, rate limit, 429, integration
updated: 2026-09-08
trust: internal
---

# API rate limits

| Plan | Requests per minute | Burst |
|---|---|---|
| Starter | 120 | 200 |
| Growth | 300 | 500 |
| Enterprise | 600 | 1,000 |
| Platform tier (add-on) | 1,200 | 2,000 |

Requests above the limit get HTTP 429 with a Retry-After header. Integrations that sync at shift start should spread requests or use the bulk endpoint `/v2/jobs/bulk-sync` (up to 500 jobs per call).

Raising the limit above the plan requires the Platform tier add-on; sales handles the change.
