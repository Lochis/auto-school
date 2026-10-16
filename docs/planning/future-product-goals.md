# Future product goals — multi-tenant auto-school

**Status:** LATER GOALS — deliberately out of scope for the current migration
(Authentik header trust, Postgres+pgvector cutover, pod-per-user). This doc
records the product vision so the migration doesn't paint us into a corner,
and lists what the planned architecture already supports vs. what needs new
design when the time comes.

Companions: `authentik-federation.md` (identity), `multi-user-architecture.md`
(worker pods), `postgres-migration.md` (schema).

## 1. Vision

auto-school as a hosted product: people log in with Authentik, complete an
onboarding wizard (reflected in their Settings tab), and get their own
recording daemon — school login validated, MFA pings routed to *their*
Discord, notes/transcripts/search under their account.

## 2. Goal-by-goal analysis

### A. Onboarding wizard + per-user settings  → supported, UI work later

What users configure on first login (all shown in their Settings tab):

| Setting | Today (single-user) | Future (per-user) |
| --- | --- | --- |
| Discord webhook (screenshots + MFA pings) | `DISCORD_WEBHOOK_URL` env (`src/config.ts:12`, `src/notify.ts`) | encrypted `user_settings` row; `notify.ts` takes webhook from user record |
| School login email/password | `TEAMS_EMAIL`, `CENTENNIAL_*` env | AEAD-encrypted per-user credential blob (already designed in `authentik-federation.md` §5) |
| TOTP secret | `TOTP_SECRET` env | same encrypted blob |
| AI keys (see C) | `.env` (`GEMINI_API_KEY`, `GLM_API_KEY`) | same blob, optional per-user override |

Architecture fit: the users table + encrypted-blob design covers all of it.
New work when we get there: onboarding flow (frontend wizard), per-user
settings storage/API, threading user-scoped config through the daemon
(the daemon is already env-parametrized per worker pod — `src/config.ts`
reads env per pod in the pod-per-user model, so credentials arrive as
per-user k8s Secrets *or* DB blob at pod provision time; pick one at
implementation).

### B. AI-assisted login-flow builder for arbitrary schools  → the big new bet

Today the login bot is hardcoded: Microsoft selectors (`src/login/selectors.ts`)
+ a Centennial/WSO2 SSO state machine in `src/login/teams-login.ts` + TOTP
(`totp.ts`). Every new school = new selectors, new redirect flow, new MFA
quirks. Hand-coding one school at a time does not scale to a product.

Proposed model (deferred, but architecturally compatible):

- **Login recipes**: a declarative per-school recipe (ordered steps: expected
  URL patterns, DOM selectors, "type email → submit → if selector X appears,
  type password", MFA panel detection). New DB table `login_recipes`
  (school_key, version, recipe JSON) shared across users of the same school,
  with per-user overrides; the user's daemon loads their recipe at launch.
  Zero conflict with pod-per-user — recipes are just config data.
- **AI generation of recipes**: user gives their login page URL (+ school
  name); a vision-capable LLM walks the page, identifies form fields/next
  buttons, produces a candidate recipe. Precedents: LLM browser agents
  (browser-use pattern) do exactly this — DOM + screenshot → action.
- **Human-in-the-loop validation** (reusing what already works): the trial
  run streams screenshots to the user's Discord (same mechanism as today's
  MFA ping, `src/notify.ts` attachments) and/or shows a watch-only view;
  user confirms each step; validated recipe is versioned and stored. If the
  recipe stalls, onboarding falls back to "point at the fields once" manual
  selector help. **The LLM never sees the password** — it maps the flow;
  credentials are injected by the recipe runner at runtime, same as
  `teams-login.ts` does today.
- **Drift detection**: selectors die (`selectors.ts` header already warns
  they drift). Later: on login failure, capture DOM+screenshot, LLM proposes
  a recipe patch, owner of that school's recipe (or the user) approves.

New work when we get there: recipe schema + runner abstraction (generalize
the state machine), generation pipeline, recipe storage + versioning. This
is the largest genuinely-new subsystem — but it's additive (new table + new
module), not architectural.

### C. AI keys: bring-your-own vs platform-provided (charging)  → both viable, decide later

Current LLM layer already has the hard parts: multi-provider (`src/pipeline/llm.ts`
Gemini + GLM), per-model quota chain with 429 cooldowns (`src/status.ts`),
settings-driven model choice. Options if charging:

| Model | Pros | Cons |
| --- | --- | --- |
| **Platform keys + quotas** (recommended default) | Simple billing; margin; provider ToS-compliant (most prohibit reselling raw API access; metered *product* access is fine) | You carry AI cost per user; needs usage metering + caps |
| **BYOK** | Zero marginal AI cost; power users like it | Key storage (encrypted blob — already designed), per-user key routing in `llm.ts`, support burden ("my key is invalid"), ToS nuance |
| **Hybrid tiering** | Free tier = metered platform keys; paid tier allows BYOK | Most code: both paths |

Recommendation: ship with platform keys + **per-user usage metering** (the
`activity_events` table in the Postgres schema is a natural metering base;
add token counts when needed), revisit BYOK as a paid-tier perk. Deciding
later is safe — key resolution becomes "user override → platform key," a
one-function change.

### D. Authentik as the customer-facing IdP  → works, swappable later

Authentik supports open/invited registration, password reset, branded login
flows — fine for a real (if small) customer cohort. Risks already flagged in
`authentik-federation.md`: your outpost is now on the product's critical
path. Because the plan keeps identity behind a thin seam
(`frontend/src/lib/auth.ts` reading `X-authentik-*`), swapping to a hosted
IdP later (Auth0/Logto/etc.) is contained to that module + ingress — not a
re-architecture.

**Social SSO (Google / Microsoft / Discord / GitHub): no schema change.**
All four are built-in Authentik *Sources*; users link them to one Authentik
account, and every login path surfaces the same `X-authentik-uid`/`sub` —
the app can stay blind to how the user authenticated.

**Concrete setup (deferred 2026-10, steps verified against current authentik):**

- Authentik: Directory → Federation & Social login → Create → source type
  (Discord / Google OAuth Source / etc.). Set **User matching mode = "Link to
  a user with identical email address"** — that folds the login into the
  existing `lochis` account (same uid → same data owner, no split history).
  Stricter variant for future tenants: "…but deny enrollment" = no self-signup.
- IdP-side OAuth apps need redirect URIs of the form
  `https://auth.vanderloch.com:2459/source/oauth/callback/<slug>/`
  (note the :2459 and trailing slash; `<slug>` = the authentik source slug).
- Google: keep the consent screen in **Testing** mode and list allowed test
  users — free allowlist, no review process needed.
- Discord: developers portal → OAuth2 → client id/secret → add the redirect.
- Verify after linking: `/api/me` must return the SAME uid as before.

Two operational notes:

- Configure source **user-matching by verified email** (or require manual
  linking) so "sign up with password, later click Sign in with Google"
  links to the SAME Authentik user instead of minting a second account —
  otherwise one human gets two uids and a split history. This is Authentik
  admin config, not app code; the claim-before-JIT flow stays as designed.
- If the Settings tab ever wants to show "connected providers" (or support
  unlinking), that data lives in Authentik and can be read via its API —
  only add an optional `user_identities` (provider, provider_uid) table if
  we decide to cache it locally. Deferred; not needed now.

### E. Billing  → out of scope, noted only

No payments work now. The substrate (users, metering events, per-user
quotas) is enough to add Stripe/usage billing later without schema surgery.

## 3. Verdict: does the planned architecture support this?

**Yes.** Pod-per-user isolates each tenant's browser/audio/recordings;
per-user encrypted blobs cover credentials, webhooks, and (optionally) AI
keys; Postgres gives users/ownership/metering; the auth seam keeps the IdP
swappable. Nothing in the product vision requires re-architecting the
migration plan — only additive work:

- Onboarding/settings UI — additive frontend
- Login recipes + AI builder — new subsystem, additive (table + module)
- BYOK — additive key-resolution layer
- Billing — additive

## 4. Explicitly NOT in the current migration

The Authentik-header, Postgres, and pod-per-user plans stay scoped as
written. Deferred from this doc: onboarding wizard, recipe system, AI key
routing, metering UI, billing, hosted-IdP swap.
