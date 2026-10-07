---
title: Mobile app: known issues
tags: mobile, android, ios, crash, known issue, release
updated: 2026-09-19
trust: internal
---

# Mobile app: known issues

## Android 15: crash when opening the job list (app 4.17)

Since release 4.17, the technician app can close when opening the job list on some Android 15 devices (Samsung A55, Pixel 8). Engineering ticket ENG-5521.

- **Fix:** release 4.18, rolling out on October 8, 2026 (Google Play staged rollout, 100% by October 10).
- **Workaround:** open the job from the dispatch notification instead of the list, or use the web app on the phone.

## iOS 19: photos upload slowly on cellular

Large photos are compressed after upload instead of before. Fixed in 4.17.2.

## Offline mode: jobs stuck in the outbox

If a technician force-quits the app while syncing, completed jobs can stay in the outbox. Ask them to open the app on Wi-Fi and pull to refresh; if that fails, collect logs (Settings > Help > Send logs).
