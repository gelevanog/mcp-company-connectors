---
title: Exporting routes and work orders to CSV
tags: export, csv, routes, timeout, reports
updated: 2026-09-22
trust: internal
---

# Exporting routes and work orders to CSV

Exports run in the browser for up to 60 seconds. Large exports (more than about 1,000 stops or 50,000 work orders) can time out.

## Large exports

- Support can raise the export timeout for an account to 5 minutes (admin console > Account > Limits).
- For audits and full-history exports, use the asynchronous export (Reports > Scheduled exports), which emails a download link when ready.
- The API endpoint `/v2/workorders/export` returns an export job id for very large data sets.
