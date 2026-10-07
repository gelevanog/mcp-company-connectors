---
title: GPS positions delayed on the dispatch map
tags: gps, tracking, map, delay, telemetry
updated: 2026-09-02
trust: internal
---

# GPS positions delayed on the dispatch map

Technician positions normally refresh every 30 seconds.

## Known incident (September 2026)

Incident INC-311: a backlog in telemetry ingestion delays positions by 10-15 minutes for all regions since September 21. Infra is migrating the ingestion queue; ETA October 3, 2026. Status page: status.kestrel.example.

## Checklist when only one customer is affected

1. Check that location permission is "Always" on the devices.
2. Battery savers on some Android phones stop background location.
3. Check the device clock; a wrong clock makes positions look stale.
