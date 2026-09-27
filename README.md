# hvac-dashboard

Business dashboard for Quality HVAC by Fibid. No health data, so the GitHub Action reads the systems directly (no droplet). The page is a static Netlify site; the data file is AES-256-GCM encrypted (PBKDF2-SHA256, 200k iterations, gzip first) and unlocked in the browser with the dashboard password.

## Secrets (GitHub → Settings → Secrets and variables → Actions)
| Name | What it is |
|---|---|
| `HCP_API_KEY` | Housecall Pro API key (MAX plan, generated from an admin login) |
| `GHL_TOKEN` | GHL Private Integration token (`pit-…`), view-only scopes: contacts, conversations, conversations/message, opportunities, locations |
| `GHL_LOCATION_ID` | The ID after `/location/` in the GHL sub-account URL |
| `WINDSOR_API_KEY` | Windsor.ai API key |
| `DASHBOARD_KEY` | The dashboard password |
| `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` | Netlify deploy token and the `hvac-dashboard` site ID |

The first step of every run (`scripts/check.mjs`) prints OK or FAIL for each connection. 401 = key invalid, 403 = valid key missing permission/plan, 404 = wrong ID.

## How each number is computed
- **Revenue / jobs / average job**: Housecall Pro jobs with a completed status, dated by completion, `total_amount` (cents). Cancelled jobs excluded. Lessen property-management work is not in the pilot.
- **Job type**: regex on job type, description, tags and line items (`config.json → job_types`).
- **New customer**: the customer's first completed HCP job.
- **Lead**: a new GHL contact whose source isn't the HCP/Lessen sync and who wasn't already an HCP customer when the contact was created. Text-campaign replies are past customers, not leads.
- **Attribution**: channel from GHL source, tags and attribution fields (`config.json → channels`). Credit only when the lead existed before the first HCP job and within 365 days. Booked = HCP job created after the lead. Cohorted by lead month, so customers can never exceed leads. Unknown source → credited to no one.
- **Calls**: inbound GHL call messages (Google Ads, Meta, LSA tracking lines), last 90 days. Voicemail and no-answer/busy/failed are the missed floor; "completed" is not proof of a conversation. Grasshopper main-line calls are not in GHL.
- **First reply**: first outbound message not sent by a workflow/campaign, or an answered inbound call, after the lead's first inbound touch.
- **Waiting**: conversations whose last message is inbound, within 30 days.
- **Spend**: Windsor Google Ads and Meta, excluding other clients' and hiring campaigns (`exclude_campaigns`). Meta campaign rows are checked against an account-wide pull. LSA spend is entered monthly in `data/lsa-spend.json` from LSA billing's "Home Services Ads activity" line.
- **Listings**: each of the three GBP locations pulled separately. Review totals from the review table, not summary fields. Last 3 days are Windsor lag.
- **Rankings**: Search Console, non-brand queries, impression-weighted average position by week. Website results, not the map pack.

## Preview locally
`FIXTURE=1 NO_ENCRYPT=1 node scripts/build.mjs` then serve `public/`. Fake data only; `public/data.json` must never be committed.

## Updating
Upload everything except the `data` folder unless you're entering LSA spend.
