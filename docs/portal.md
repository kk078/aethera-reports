# Hosted client portal

The hosted client portal (Phase 3 chunk F) is an optional Cloudflare
Worker (`portal/`, Hono + D1) that lets a firm publish a client's report
as a mobile-friendly, read-only web page and email each recipient a
private, expiring link instead of (or alongside) attaching files. It
never stores patient-level data — only the aggregate `ClientReport` JSON
the desktop app already builds for dashboards/exports.

Like `server/` (shared server mode), this is entirely optional: the app
works exactly the same without it. Nothing here is deployed as part of
building this feature — the steps below are for whoever chooses to run
it.

## 1. What gets published

`ClientReport` (`src/shared/domain.ts`) — the exact same JSON shape
`buildClientReport()` returns for the in-app dashboard and PDF/PPTX/XLSX
exports: financials, KPIs, A/R aging, denials by root cause, claims by
status, payer mix, and (when available) the benchmark block. **Never**
claim-level or patient-level detail. Every publish re-validates the
payload against `clientReportSchema` and silently strips any field that
isn't part of that shape — even if a future bug somewhere upstream tried
to smuggle extra data into the JSON, the portal's own publish endpoint
would drop it before it ever reaches storage.

## 2. Deploying the Worker

Everything below assumes `cd portal/` first.

```bash
# One-time: dependencies (hono is already a dependency of the repo root;
# wrangler and @cloudflare/workers-types are devDependencies there too —
# nothing extra to install inside portal/ itself).

cp .env.example .env
# Edit .env: CLOUDFLARE_ACCOUNT_ID and a scoped CLOUDFLARE_API_TOKEN for
# this project only — never `wrangler login` globally (per this
# project's account conventions).

# Create the D1 database, then paste the printed database_id into
# wrangler.toml's [[d1_databases]] block:
npx wrangler d1 create aethera-reports-portal

# Apply the schema (local dev DB, then production):
npx wrangler d1 migrations apply aethera-reports-portal --local
npx wrangler d1 migrations apply aethera-reports-portal --remote

# Secrets (never committed):
npx wrangler secret put ADMIN_TOKEN       # generate one: openssl rand -hex 32
npx wrangler secret put SESSION_SECRET    # generate one: openssl rand -hex 32

# Local dev server:
npx wrangler dev

# Deploy:
npx wrangler deploy
```

`ADMIN_TOKEN` and `SESSION_SECRET` must be two **different** random
values — see `portal/src/session.ts`'s header comment for why the
session cookie's signing key is deliberately not the admin token.

### Custom domain / route

`portal/wrangler.toml` has a commented-out `[[routes]]` block using
`reports.aetherahealthcare.com` as the documented example (the reference
deployment's intended hostname, same Cloudflare account as
`aethera-academy` — not a hardcoded dependency of the public project).
Uncomment it and change the hostname to your own domain, then attach the
domain to the Worker the normal way (Cloudflare dashboard → Workers →
your Worker → Domains & Routes, or `wrangler deploy` picks up the
`[[routes]]` block directly once the zone is on your account).

## 3. Connecting the desktop app

**Settings → Hosted client portal**: enter the Worker's URL and the
`ADMIN_TOKEN` you set above, then **Test connection**. The token is
encrypted at rest the same way the RCM connector's/SMTP's passwords are
(OS-level credential store where available, documented plaintext
fallback otherwise).

From there:

- **ClientDetail → "Publish to portal"** publishes that client+period's
  report and (unless the "Email links" checkbox is unchecked) mints and
  emails a private link to every `report_recipients` address.
- **Automation → a rule with Delivery = "Publish to portal + email
  links"** does the same thing on a schedule, in addition to the rule's
  normal file export.

## 4. Link lifecycle

- A link is a 256-bit random token; only its SHA-256 hash is ever stored
  (`access_tokens.token_hash`) — the raw token exists solely in the
  minted URL, in the recipient's inbox, and briefly in the querying
  admin request. Validating a presented token looks it up **by hash**
  (an indexed exact-match query), never by comparing raw strings.
- Default TTL: 30 days (configurable per mint via the admin API's
  `ttlDays`, though the app's UI always uses the default today).
- Visiting a valid link sets a short (1 hour) signed session cookie
  scoped to that one client code, then redirects to that client's report
  list — so browsing between published periods doesn't need the token
  in every URL. The session's expiry is embedded in the signed cookie
  value itself and re-checked server-side on every request, not left to
  the browser's own cookie-expiry enforcement alone.
- An expired, revoked, or unknown token — and any request to a report
  page without a valid, matching session — gets the same generic
  "This link has expired" page at **403**, never a different error per
  failure reason (nothing here should help an attacker distinguish
  "wrong token" from "right token, wrong time").
- Revoke a specific snapshot: `DELETE /admin/snapshots/:clientCode/:period`
  (ClientDetail doesn't expose this yet — use the admin API directly, or
  re-publish an intentionally-corrected report, which un-revokes it).
- Revoke every active link for one recipient (e.g. they left the
  practice): `POST /admin/links/revoke` with `{ clientCode, email }`.

## 5. Security notes

- **CSP + no JavaScript**: every response carries a strict
  `Content-Security-Policy` (`script-src 'none'`), `X-Robots-Tag:
noindex`, `X-Frame-Options: DENY`, and `X-Content-Type-Options:
nosniff`. There is no `<script>` tag anywhere in the portal's HTML —
  charts are server-rendered inline SVG.
- **No indexing**: `noindex, nofollow` on every page (meta tag and
  header) — a leaked/guessed URL still shouldn't end up in a search
  index.
- **Constant-time comparisons**: the admin Bearer token check and the
  session cookie's HMAC signature check both use a hash-then-XOR-compare
  helper (`portal/src/crypto-utils.ts`) instead of `===`/`!==` on raw
  strings, to avoid leaking timing information to an attacker probing
  either secret.
- **The magic-link token itself is never reflected back** into any
  response body, header, or cookie — `/r/:token` consumes it once (to
  look up its hash) and from then on only ever deals with the derived,
  time-boxed session cookie.
- **`ADMIN_TOKEN` is a bearer credential for the whole portal** — anyone
  with it can publish/revoke snapshots and mint links for any client.
  Treat it like a database password; only the desktop app(s) authorized
  to publish should have it.
- **Disk/at-rest encryption**: D1 is Cloudflare-managed storage — refer
  to Cloudflare's own documentation for its at-rest encryption posture;
  this project makes no additional claims about it. The one thing this
  project's data-policy applies regardless: snapshots contain only
  aggregate figures, never patient-level data, so the blast radius of
  any storage-layer compromise is bounded by design, not by encryption
  alone.
