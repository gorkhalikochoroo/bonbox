# Incident procedure

What to do when BonBox is down, a money path is failing, or personal data may
have leaked. Written for one person at 02:00: follow it top to bottom.

**Rule for every note you write during an incident:** no names, e-mails,
phone numbers or allergy notes, in this repo, in the breach register, in
chat, or in a ticket. Use categories, counts and internal ids only.

---

## Where the data lives

Datatilsynet's form and every venue owner will ask where the data is
processed. `/privacy` gives the same answer under "Who has access to your data".

| What | Where |
|---|---|
| API (`bonbox-api`, one worker) | Render, region **Frankfurt (EU)**. No persistent storage on the server. |
| Database and uploaded files (primary) | Supabase project `qwogfearhfhaunqpuvgd`, region **eu-central-1 (Frankfurt)**, since 20 Oct 2026. Files are in Storage bucket `receipts`. |
| Old primary (fallback copy) | Supabase project `ahlqhztujpeccmaivkhr`, region eu-west-1 (Ireland). Unchanged copy of the database and files as of 20 Oct 2026, kept as a fallback until Manoj says delete. Not live: never restore into it or point the API at it without a decision. Remove this row when it is deleted. |
| Backup project | Supabase project `bonbox-backup`, region **eu-central-1 (Frankfurt)**. Empty until the nightly backup release is live; then it holds encrypted nightly copies of the database and the files. |
| Frontend | Vercel, global CDN. Static files only, no customer data. |
| Domain and DNS (`bonbox.dk`, every mail record: MX, SPF, DKIM, DMARC) | Simply.com (registrar and DNS). |
| E-mail sending | Resend (region not confirmed, as `/privacy` says). |

BonBox has **no Cloudflare account**. The `cf-ray` / `server: cloudflare`
headers on `api.bonbox.dk` come from Render's own edge. Edge problems go to
Render support.

---

## (a) Roles

| Role | Who |
|---|---|
| Incident lead | Manoj |
| Backup contact | `TBD by owner` |

The incident lead decides severity, contains, and owns the 72-hour clock.

---

## (b) Detection sources

1. **Ops alert e-mail and push**, subject starting `[BonBox ops]`. One capped,
   deduplicated digest every 15 minutes at most (backend
   `services/ops_alert.py`, `jobs/ops_triage_job.py`). It names error types,
   routes, counts and fingerprints only. Details live in `/admin`.
2. **Uptime monitor: owner action, not set up yet.** Add both URLs to an
   uptime monitor that alerts you: `https://api.bonbox.dk/api/health/ready`
   (the app is up and its database answers) and
   `https://api.bonbox.dk/api/health/storage` (file storage is durable).
   Until then, open them by hand when something looks wrong. Render's own
   health check on `/api/health/ready` only gates a deploy; it does not
   alert you. Storage that is not durable is also alerted once a day by
   source 1.
3. **Stripe "webhook failing" e-mails.** Since R-i a failed webhook answers
   500, so Stripe retries for up to 3 days and e-mails when it keeps failing.
4. **The support chip** in the app and **`/admin` recent errors**
   (`GET /api/admin/recent-errors`, `GET /api/admin/triage-notes`).

---

## (c) Severity

| Level | Meaning | Examples |
|---|---|---|
| **SEV1** | Outage, or a confirmed personal-data breach | API down; host stand unusable during service; guest data exposed |
| **SEV2** | One surface down, or a money path failing | Stripe webhook failing; daily close cannot save; uploads refused |
| **SEV3** | Degraded | Slow pages; one job failing; a monitor flapping |

Allergy notes in reservations may be **health data (GDPR Art. 9)**. Any
incident that may expose them is at least SEV1 and raises the breach risk
level (section e).

---

## (d) First hour

1. **Contain.**
   - Render: roll back to the previous deploy (Dashboard → bonbox-api →
     Deploys → previous successful deploy → Rollback).
   - Too many alerts: set `OPS_ALERTS_ENABLED=false` on Render. Errors are
     still recorded in `error_logs` and triage notes; only the e-mails and
     pushes stop.
   - Disable the affected feature with its flag (see section f, "Flags").
   - **Data lost or corrupted:** stop the writes first (roll back the deploy,
     or switch off the feature), then restore:
     - *Database:* Supabase dashboard → primary project
       (`qwogfearhfhaunqpuvgd`, eu-central-1 Frankfurt) →
       Database → Backups. A restore replaces the whole database, so export
       anything newer you must keep first. What is kept, and for how long,
       depends on the Supabase plan: check that page now, not during an
       incident. Supabase's database backups do **not** contain the files in
       Storage.
     - *Files, or the database from another night:* the backup project
       `bonbox-backup` (eu-central-1), once the nightly backup release is
       live. Restore with `backend/scripts/restore_from_backup.py` (it ships
       with that release). It needs `BACKUP_ENCRYPTION_KEY` and the
       `APP_SECRET_KEY` that was live when the copy was taken, both from the
       password manager. Until that release is live, the backup project holds
       nothing.
       The script refuses to write into a protected project: the live
       primary `qwogfearhfhaunqpuvgd` (Frankfurt), the old primary
       `ahlqhztujpeccmaivkhr` (Ireland, the fallback copy), and whatever
       project `$SUPABASE_URL` / `$DATABASE_URL` name, in any URL form
       (pooler on 5432 or 6543, the `db.<ref>.supabase.co` host, the
       `https://<ref>.supabase.co` photo target). Photos go back into a
       protected project's bucket only with `--allow-main-project` plus
       `--confirm-target <bucket>`, and never overwrite an object that is
       there. (Until the receipt-relink release the guard still named only
       Ireland, so only the exact `$DATABASE_URL` match protected Frankfurt.)
2. **Preserve evidence.**
   - Do **not** purge `error_logs` or delete triage notes.
   - Export the `/admin` recent errors and triage notes for the incident
     window and keep the export outside the app. Do it early: the nightly
     maintenance deletes both after 30 days.
   - Note the deployed commit from `https://api.bonbox.dk/api/health`.
3. **Open the breach-register entry** (`docs/runbooks/breach-register.md`)
   the moment personal data *may* be involved, even if it later turns out
   not to be a breach. Record the discovery time in UTC.

---

## (e) GDPR: the 72-hour clock

**T0** = the moment BonBox becomes reasonably certain that a breach affecting
personal data has occurred. Write T0 in the register (UTC).

### Controller path: owner accounts and billing data

BonBox is the **controller** for venue-owner accounts, logins and billing.

- Notify **Datatilsynet within 72 hours of T0** (GDPR Art. 33(1)), unless the
  breach is unlikely to result in a risk to people's rights and freedoms.
- Notification may be **phased** (Art. 33(4)): send what you know, add the rest
  as you learn it.
- Record the reason for any delay past 72 hours, and the reason for any
  decision **not** to notify, in the register.

### Processor path: guest, reservation, allergy and staff data

BonBox is the **processor** for data venues keep about their guests and staff
(reservations, allergy notes, staff schedules and documents). The venue owner
is the controller.

- Notify **each affected venue owner without undue delay** (Art. 33(2)).
  Target: within **24 hours of T0**, or sooner if the data processing
  agreement says so.
- Tell them: the data categories, approximate counts of people and records,
  likely consequences, and the measures taken or proposed, so they can meet
  their own 72-hour deadline.

### Art. 34: telling the people affected

Where the breach is likely to result in a **high risk**, the controller
informs the data subjects directly. For owner data that is BonBox; for guest
and staff data it is the venue, and BonBox assists (counts, wording, which
records).

### Datatilsynet contact (verified 2026-10-11)

- Breach report: on datatilsynet.dk, menu "Sikkerhedsbrud", page
  "Anmeld brud på persondatasikkerheden"
  (`https://www.datatilsynet.dk/sikkerhedsbrud/anmeld-sikkerhedsbrud`); the
  form itself is submitted through Virk.dk. Download a copy of the submitted
  report as proof.
- E-mail: dt@datatilsynet.dk
- Phone: +45 33 19 32 00 (Mon, Tue, Thu, Fri 10:00-12:30)

---

## (f) Key rotation list

Names only; values live in the Render dashboard (`backend/render.yaml` lists
every key). Rotate a key that may have leaked, then redeploy.

**Warning:** rotate `APP_SECRET_KEY` only together with
`APP_SECRET_KEY_PREVIOUS` (old value moves to `_PREVIOUS`), otherwise
encrypted rows become unreadable. The same applies to `SECRET_KEY` with
`SECRET_KEY_PREVIOUS` (otherwise every session is signed out).

| Group | Keys |
|---|---|
| Signing / encryption | `SECRET_KEY`, `SECRET_KEY_PREVIOUS`, `APP_SECRET_KEY`, `APP_SECRET_KEY_PREVIOUS`, `GAVEKORT_SIGNING_KEY`, `TICKET_SIGNING_KEY`, `BOOKING_TOKEN_KEY`, `BONBOX_CRON_SECRET` |
| **Never set** | `ORIGIN_SHARED_SECRET`: setting it makes the API refuse every request without a header that only a Cloudflare zone of our own could add, and BonBox has none. Leave it unset, also during an incident. |
| Database | `DATABASE_URL` |
| Storage | `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_TEST` |
| Mail / ops | `RESEND_API_KEY`, `SENTRY_DSN` |
| AI | `ANTHROPIC_API_KEY` |
| Push | `VAPID_PRIVATE_KEY`, `APNS_AUTH_KEY` |
| SMS / WhatsApp | `GATEWAYAPI_TOKEN`, `TWILIO_AUTH_TOKEN` |
| OCR | `MINDEE_API_KEY`, `GOOGLE_VISION_API_KEY`, `OCRSPACE_API_KEY` |
| Inbox | `POSTMARK_INBOUND_USER`, `POSTMARK_INBOUND_PASS` |
| Bank / MobilePay | `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY`, `AIIA_CLIENT_SECRET`, `SALTEDGE_SECRET`, `YAPILY_APPLICATION_SECRET`, `MOBILEPAY_CLIENT_SECRET` |
| Flags (contain, not rotate) | `OPS_ALERTS_ENABLED`, `INBOX_ENABLED`, `WHATSAPP_ENABLED`, `ENABLE_BANK_CONNECT`, `DEBUG_BILLING_ENABLED`, `PORTAL_PIN_ENFORCE`, `STRIPE_TOS_CONSENT` |

---

## (g) Vendor status and security

Security pages and the Vercel, Resend and Simply.com pages were opened on 2026-10-11; the other status pages are the vendors' standard addresses.

| Vendor | Status page | Security / trust |
|---|---|---|
| Stripe | https://status.stripe.com | https://docs.stripe.com/security |
| Supabase | https://status.supabase.com | https://supabase.com/security |
| Render | https://status.render.com | https://render.com/security |
| Vercel | https://www.vercel-status.com | https://vercel.com/security |
| Resend | https://resend-status.com | https://resend.com/security |
| Anthropic | https://status.anthropic.com | https://trust.anthropic.com |
| Simply.com (domain, DNS, mail records) | https://www.simply.com/dk/serverstatus/ | Support: https://www.simply.com/dk/support/ · Compliance: https://www.simply.com/dk/compliance/ |

No account ids in this file. Log in to each dashboard to open a support case.
A DNS hijack, an expiring domain or mail that stops arriving (including the
security contact in `security.txt`) starts at Simply.com: check the records
and the domain status in its control panel first.

---

## (h) Post-incident review

Within **7 days** of the incident:

1. Timeline (UTC): detection, T0, containment, notifications, resolution.
2. Root cause and why the detection sources did or did not catch it.
3. What changes (code, config, monitor, this runbook), each with an owner.
4. Close the breach-register entry (or record "not a breach" with the reason).
