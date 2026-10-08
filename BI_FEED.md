# Power BI data feed

Read-only, de-identified tables for Power BI's **Web** connector.

## Server setup (Render)
Add environment variables, then redeploy:

- `BI_API_KEY` — a long random secret (e.g. 40+ chars). If unset, the feed is disabled (503).
- `BI_CACHE_SECONDS` — optional, default `600`. All tables share one cached Firestore read pass.

## Endpoints
`GET https://<render-url>/api/bi/<table>` — send the key as header `X-API-Key: <key>` (preferred) or `?key=<key>`.

| Table | One row per |
|---|---|
| `cohorts` | cohort, with registration/FGD/selected/enrolled/graduated counts |
| `participants` | participant (codes, gender, age, institution, statuses, FGD, average score) |
| `fgds` | FGD, with attendance counts and average score |
| `evaluations` | submitted/draft evaluation, with rubric scores |
| `champions` | champion, with roles and evaluation counts |

Default output is CSV (UTF-8, opens directly as a table). Add `?format=json` for JSON. `?refresh=1` bypasses the cache.

No names, emails, phone numbers, notes or free-text answers are ever returned.

## Power BI
Get Data → Web → Advanced → URL `https://<render-url>/api/bi/participants`,
HTTP request header `X-API-Key` = the key → OK → authentication **Anonymous**.
Repeat per table, then publish and schedule refresh in the Power BI service.
