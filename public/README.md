# South West Earthworks Crew Hub — deployable starter

A Node.js web app with a shared SQLite database, mobile PWA, individual employee PIN accounts, timesheets with handwritten signatures, plant/material dockets, employee history, and a manager-only office dashboard.

## Run

1. Install Node.js 20+.
2. From this folder run `npm install`.
3. Set `ADMIN_NAME` and `ADMIN_PIN` environment variables. PIN must be four digits. Example on macOS/Linux: `ADMIN_NAME='Office Admin' ADMIN_PIN='1234' npm start` (replace the example PIN before use). Windows PowerShell: `$env:ADMIN_NAME='Office Admin'; $env:ADMIN_PIN='1234'; npm start`.
4. Open `http://localhost:3000` to test locally.
5. Deploy to an HTTPS-capable Node host with **persistent disk storage** for `DATA_DIR` (defaults to `./data`). Configure HTTPS, backups, and `NODE_ENV=production`. An ephemeral host will lose records on redeployment.
6. Office manager logs in, creates individual employee accounts and PINs, and adds jobs/machines/materials.
7. Employees visit the HTTPS address on their phones and choose **Add to Home screen / Install app**.

## Important before production use

- This is a functional deployable starter, **not yet hosted**. No live URL or automatic submissions exist until deployment.
- Four-digit PINs are inherently weak; login rate limiting is included, but production should add account lockout, PIN reset, longer PINs or second factor for managers, HTTPS and monitoring.
- The server requires a persistent database, daily backups, and operational monitoring. SQLite works for a small team on a single persistent instance; do not run multiple independent instances.
- No offline entry queue: employees must be online to save or submit. Cached app shell may open without connectivity, but API requests will fail.
- Timesheet day hours support same-day shifts; overnight shifts need further development.
- Existing records in the previous standalone HTML app are **not automatically imported**.
- Before payroll use, validate totals, approval process, leave rules, and CSV output against real employee examples.
- Submitted records cannot be edited by employees unless returned by a manager. The current UI offers resubmission of returned records but not an edit form; editing API exists and a full edit UI is a follow-up.
- Admin role is manager-only; managers can see all records. No automatic Xero sync.
- Consider privacy notice, employee consent for signatures, data retention and access policies.
