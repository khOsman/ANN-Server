# Power BI data feed

Read-only, de-identified tables for Power BI's **Web** connector.

## Server setup (Render)
Add environment variables, then redeploy:

- `BI_API_KEY` — a long random secret (e.g. 40+ chars). If unset, the feed is disabled (503).
- `BI_CACHE_SECONDS` — optional, default `600`. Each collection is read at most once per window.
- `BI_INCLUDE_PII` — optional, default off. Set to `true` to return names/emails/phones/notes in the raw feed.

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

## Raw per-collection feed (for your own star schema)
`GET /api/bi/raw` lists them; `GET /api/bi/raw/<collection>` returns every document as a row (`id` first).

`audit_log`, `champions_pool`, `cohorts`, `counters`, `data_points`, `databases`, `fgds`, `form_fields`,
`form_responses`, `forms`, `participant_evaluations`, `participants`, `users`, plus
**`form_response_answers`** — one row per answered question (response_id, participant_id, field, label, value),
the natural fact table for question-level analysis.

- Timestamps are ISO-8601. Nested objects/arrays are JSON text in CSV (Power Query: Transform > Parse > JSON) or real JSON with `?format=json`.
- Credential-like fields (token/secret/password/hash/otp) are never returned.
- `impersonation_sessions` is never exposed.
- Unless `BI_INCLUDE_PII=true`: name/email/phone/DOB/notes/feedback keys are removed from people collections
  (participants, champions_pool, fgds, form_responses, participant_evaluations, audit_log, users); the
  `answers` column of `form_responses` and `custom_data` of `participants` are dropped (use
  `form_response_answers`, where identifying answers are blanked). Join on `participant_id`, `participant_code`, `cohort_id`, `fgd_id`, `champion_id`.

## Power BI
Get Data → Web → Advanced → URL `https://<render-url>/api/bi/participants`,
HTTP request header `X-API-Key` = the key → OK → authentication **Anonymous**.
Repeat per table, then publish and schedule refresh in the Power BI service.
