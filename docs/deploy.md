# Deploying Orion

Two hosts, not one.

- **Vercel** runs the Next.js frontend.
- **Render** runs the Spring backend (`orion-backend`) and the FastAPI AI worker
  (`orion-ai`).

Backing it: **Neon** (Postgres), **Confluent Cloud** (Kafka), **Cloudflare R2**
(object storage), **Clerk** (identity), **AssemblyAI** (speech-to-text) and
**OpenAI** (summaries, chat, embeddings).

```
                    Internet
                       |
                       v
          Vercel  --  Orion frontend (Next.js)
                       |
                  HTTPS / WSS
                       |
                       v
          Render  --  orion-backend (Spring, public web service)
                       |
                       +--> Neon              Postgres + RLS
                       +--> Cloudflare R2     recordings, exports
                       +--> Confluent Cloud   meeting_uploaded
                       |
                       v
          Render  --  orion-ai (FastAPI, PRIVATE service)
                       |
                       +--> AssemblyAI        transcription + diarization
                       +--> OpenAI            summary, chat, embeddings
```

`orion-ai` is a Render **private service**: it has no public URL, and is reached
only by the backend and by Kafka. The browser never talks to it.

[`render.yaml`](../render.yaml) declares the two Render services and nothing
else — the frontend's configuration lives in Vercel's project settings, not in
that file. Neither can do the one-time provisioning below, and several steps
here are the difference between a deployment that works and one that comes up
healthy while being silently wrong.

---

## 0. Before anything: the failure modes that do not announce themselves

Every item in this section fails by *working*. The service starts, the health
check passes, pages render — and something is wrong that no log line mentions.
That is what makes them worth a section of their own.

**The production profile catches most of them now.** `render.yaml` sets
`SPRING_PROFILES_ACTIVE=production`, which switches on `DeploymentCheck`: the
backend refuses to start if any setting below is still the development one, and
names all of them at once rather than one per restart. Nothing else sets that
profile — `docker-compose` deliberately does not, because the local stack *is*
the development configuration.

**Auth mode.** `ORION_AUTH_MODE` defaults to `clerk`, in `application.yml`
and on every `@Value` that reads it. In dev mode `AuthenticationFilter` and
`StompAuthInterceptor` trust an `X-Dev-User` header, so *any* request — and any
websocket — can impersonate *any* user. The blueprint hardcodes `clerk`; do not
override it.

> It defaulted to `dev` until recently, and the fail-closed default written on
> the `@Value` was cancelled by `application.yml` supplying `dev` explicitly — a
> `@Value` default applies only when a property is *absent*. Two defaults for
> one decision, and the weaker one won silently. `ApplicationDefaultsTest` now
> resolves the real YAML with an empty environment and pins the answer.

**The internal callback token.** `ORION_INTERNAL_TOKEN` has **no default**.
It used to fall back to `dev-internal-token`, which is committed to this
repository and printed further down this page, so a deployment that never set it
looked exactly like one that did — while accepting result callbacks from anybody
who had read the source. Those callbacks write transcripts and mark meetings
READY. Unset now means `InternalTokenFilter` refuses every `/internal/**`
request: meetings pile up in PROCESSING and the ai-service logs 401s, which is
loud and traceable in a way that silent acceptance is not.

**URLs that have no scheme.** Render's blueprint cannot produce a URL.
`fromService` with `property: host` yields a bare `orion-backend.onrender.com`,
and a bare host is not an origin — CORS compares it against the browser's
`https://…` and never matches, so every request fails and it reads as "the API
is down". `APP_FRONTEND_URL`, `APP_PUBLIC_URL` and `SPRING_CALLBACK_URL` are
therefore `sync: false` and filled in by hand, with the scheme. `AI_SERVICE_URL`
is the one exception: it names a private service, where `http` is the only
possibility, so `AiClient` supplies it.

The same trap exists on the Vercel side for `NEXT_PUBLIC_API_URL`, which is not
in `render.yaml` at all — see [section 7](#7-vercel--the-frontend). A
scheme-less value there is worse, because it becomes a *relative* path and the
app calls itself instead of the API.

**`APP_PUBLIC_URL` is not the frontend URL.** It is where *this API* is
reachable from the public internet, and only the calendar feed uses it — fetched
by Google's and Apple's servers rather than by the user's browser. It was
missing from the blueprint entirely, so it fell back to `http://localhost:8080`
and every subscribed calendar quietly stopped updating. Nothing in the app shows
this; the feed simply never refreshes.

**`APP_FRONTEND_URL` is the Vercel origin.** Not a Render host — the frontend is
not on Render. It is the public origin Vercel serves the app from, e.g.
`https://<your-project>.vercel.app`, with the scheme and no trailing slash. It is
the *only* allowed CORS origin and the *only* allowed STOMP origin, so a wrong
value blocks every browser request and every socket while the backend stays
perfectly healthy — which reads as "the API is down" rather than as a
misconfiguration.

**Frontend build-time values.** `NEXT_PUBLIC_*` are inlined into the client
bundle by `next build`, not read at runtime — and they are set in **Vercel**, not
in `render.yaml`. Change one and you must trigger a new *build*, not a restart: a
redeploy of the existing build silently keeps serving the old bundle pointing at
the old API URL.

**`CLERK_SECRET_KEY` is the one that takes the whole site down.** It is the only
non-`NEXT_PUBLIC_` variable the frontend needs — set it **in Vercel** — and
`clerkMiddleware` reads it from the environment *implicitly*: there is no
`process.env.CLERK_SECRET_KEY` anywhere in the source to grep for. Without it the
middleware throws on every request that matches, including the public marketing
page, and the site answers 500 rather than degrading. It must never gain a
`NEXT_PUBLIC_` prefix, which would inline your Clerk backend credential into the
browser bundle.

**Things that are off unless you switch them on.** Neither of these fails; both
just quietly do less.

| Unset | What silently happens |
|---|---|
| `SPEAKER_PROFILE_KEY` (ai-service) | Speaker identification is off entirely — no voice template computed, nothing stored. Correct default: the alternative is encrypting biometric-shaped data with the key committed in `docker-compose.yml`. |
| `S3_PUBLIC_ENDPOINT` (ai-service) | AssemblyAI stops fetching recordings from R2 itself, so every file is downloaded into the container and uploaded again instead of never touching it. |

---

## 0b. What the `production` profile changes

`render.yaml` sets `SPRING_PROFILES_ACTIVE=production` and nothing else does, so
none of this affects local development.

| | Local | Production |
|---|---|---|
| `DeploymentCheck` | off | refuses to start on any development-shaped setting |
| `/swagger-ui`, `/v3/api-docs` | 200 | **404** — the full API surface is not published |
| `/actuator/metrics` | 200 | **404** — pool pressure, disk, and every served URI template |
| `/actuator/health` | 200 | 200 — Render's health check needs it |
| `forward-headers-strategy` | off | `framework` — so HSTS is emitted and `isSecure()` is true behind Render's TLS |

Verified by running both profiles side by side, not by reading the config.

---

## 1. Neon

The database is `neondb`, owned by `neondb_owner`. That role is not a superuser
but does hold `CREATEROLE` **and** `BYPASSRLS`, which is what makes the security
model portable: Postgres only lets a role grant attributes it holds itself, so
`neondb_owner` can create the privileged system role. (Verified against the
instance — if you move to a provider whose owner lacks `BYPASSRLS`, the split
in `TenantDataSourceConfig` cannot be reproduced and needs rethinking.)

### 1.1 Get both URLs

Neon's dashboard gives a **pooled** host (contains `-pooler`) and a **direct**
host (the same name with `-pooler` removed). You need both:

| Use | Endpoint | Why |
|---|---|---|
| Runtime (`SPRING_DATASOURCE_URL`, `PG_HOST`) | **direct** | Row-level security is armed with a session-level setting on each connection, and a transaction-mode pooler gives the next transaction a different server connection. Hikari is already the pool this process needs |
| Migrations (`FLYWAY_URL`) | **direct** | Flyway holds an advisory lock across several transactions; a transaction-mode pooler will not keep it |

> **Both are the direct host.** This table used to say `pooled` for the runtime,
> and that shipped. The result is not an error: RLS matches nothing on a
> connection that never received the tenant, so the API answers 200 with an
> empty list and a straight-faced 404 — an intact account showing "No
> conversations", an empty folder rail, "Meeting not found", "Transcript
> unavailable" — intermittently, per request, because it depends on which
> backend the pooler handed that transaction. Reloading re-rolls it, which is
> why reloading looks like a fix. The same mechanism can hand one tenant's rows
> to another. `DeploymentCheck` now refuses to start on a `-pooler` runtime URL.

> `.env` currently has `DEPLOY_DATABASE_URL_POOLED` set and
> `DEPLOY_DATABASE_URL_DIRECT` **empty**. Fill the direct one in before
> deploying, or migrations will run through the pooler and can deadlock or
> half-apply.

### 1.2 Convert to JDBC

Neon hands you a libpq URL:

```
postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

Spring needs the `jdbc:` form, with credentials supplied separately and
**`channel_binding` removed** — it is a libpq parameter the JDBC driver does not
understand:

```
SPRING_DATASOURCE_URL=jdbc:postgresql://ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
FLYWAY_URL=jdbc:postgresql://ep-xxx.region.aws.neon.tech/neondb?sslmode=require
```

### 1.3 Create the two runtime roles

`infra/postgres-init/01-app-role.sql` runs automatically only on a fresh Docker
volume. On Neon, run it **once by hand as `neondb_owner`**, against the direct
endpoint. It creates `orion_app` (no bypass — every user request) and
`orion_sys` (`BYPASSRLS` — outbox relay, worker callbacks,
share links, provisioning).

Change the two passwords from the development defaults first; they are what
`SPRING_DATASOURCE_PASSWORD` and `ORION_DATASOURCE_SYSTEM_PASSWORD` must be
set to.

### 1.4 Migrate

The backend runs Flyway on boot, so the first deploy migrates. `V2` issues
`CREATE EXTENSION IF NOT EXISTS vector` — `vector` 0.8.1 is available on the
instance but not yet installed, and `neondb_owner` may create it.

Note the version gap: local development runs Postgres **16**, Neon serves
**18.4**. The migrations use nothing version-specific, but this is the first
place to look if one behaves differently than it did locally.

### 1.5 Verify isolation actually survived the move

Do not skip this. Connect as `orion_app` and confirm the tenant boundary
holds on the real database:

```sql
SET app.user_id = '<some real user id>';
SELECT count(*) FROM meetings;          -- only that user's rows
SELECT set_config('app.bypass','on',false);
SELECT count(*) FROM meetings;          -- MUST be unchanged
SELECT count(*) FROM outbox_events;     -- MUST be 0
ALTER ROLE orion_app BYPASSRLS;      -- MUST be denied
```

---

## 2. Confluent Cloud

One topic, and it is load-bearing. `meeting_uploaded` carries job dispatch from
the backend's outbox to the ai-service worker; break it and nothing transcribes.
Everything the UI shows — each stage, the transcript, the summary and a failure
— travels over the internal HTTP callbacks instead, so Kafka volume here is one
message per meeting.

### Create the cluster

A **Basic** cluster in the region nearest the Render services. Basic bills on
consumption and costs nothing at rest, which for one message per meeting is the
right shape.

### Create the topic

One topic, **1 partition**, replication factor left at the default:

```
meeting_uploaded
```

An older build created eight. The other seven carried stage and billing events
that nothing consumed except a logger, and they were removed — if your cluster
still has them, they are inert and can be deleted at your convenience.

Confluent Cloud enforces a replication factor of **3** and rejects an explicit 1
with `POLICY_VIOLATION`, so `KafkaTopicsConfig` asks for `replicas(-1)` — Kafka's
sentinel for "broker default", which resolves to 1 on the local single-node
broker and 3 here. Do not change it back to a literal.

Creating them by hand is still worth doing: `KafkaAdmin` only *logs* a failed
topic creation, and `spring.kafka.listener.missing-topics-fatal` is `false`, so a
topic that never got created produces a healthy-looking backend whose uploads
never reach the worker.

### Create the API key

One key scoped to the cluster (**Global access** is fine for a single-tenant
deployment; granular access needs ACLs for both service accounts on all eight
topics plus the `orion-backend` and `ai-service` consumer groups). **The
secret is shown once** — copy both halves before closing the dialog.

Confluent's own docs note it can take ~90 seconds for a new key to propagate; an
immediate deploy can fail authentication and then succeed on retry.

### Wire the credentials

The bootstrap server is on the cluster's *Cluster settings* page and looks like
`pkc-xxxxx.<region>.aws.confluent.cloud:9092` — port **9092**, same as plaintext
Kafka, so the port is not a hint that TLS is off.

The two services take the same secret in different shapes — the backend as a JAAS
string, the ai-service as a username/password pair:

```bash
# backend  (note the SPRING_ prefix on the bootstrap var — the ai-service has none)
SPRING_KAFKA_BOOTSTRAP_SERVERS=pkc-xxxxx.<region>.aws.confluent.cloud:9092
KAFKA_SECURITY_PROTOCOL=SASL_SSL
KAFKA_SASL_MECHANISM=PLAIN
KAFKA_SASL_JAAS_CONFIG=org.apache.kafka.common.security.plain.PlainLoginModule required username="API_KEY" password="API_SECRET";

# ai-service
KAFKA_BOOTSTRAP_SERVERS=pkc-xxxxx.<region>.aws.confluent.cloud:9092
KAFKA_SECURITY_PROTOCOL=SASL_SSL
KAFKA_SASL_MECHANISM=PLAIN
KAFKA_SASL_USERNAME=API_KEY
KAFKA_SASL_PASSWORD=API_SECRET
```

Two things bite here. The **trailing semicolon** in the JAAS string is required —
without it the client fails to parse the login module and reports it as an
authentication failure, which sends you looking at the wrong thing. And the
bootstrap variable is `SPRING_KAFKA_BOOTSTRAP_SERVERS` on the backend but plain
`KAFKA_BOOTSTRAP_SERVERS` on the ai-service; setting the wrong one leaves that
service quietly pointed at `localhost:9092`.

### Verify

Do not trust green service badges — both services degrade rather than crash when
Kafka is unreachable. Check the logs for the positive signal:

- ai-service: `Kafka worker connected to pkc-… ; consuming 'meeting_uploaded'.`
  Its absence, or a repeating `Kafka unavailable (…); retrying in Ns.`, is the
  failure.
- backend: no `Failed to create topics` warnings from `KafkaAdmin` at startup.

Then upload one meeting end to end. If it sticks at `QUEUED`, dispatch is broken —
confirm with `SELECT count(*) FROM outbox_events WHERE published = FALSE;`. That is
the designed behaviour — `OutboxPublisher` retries and preserves order, so a
Kafka outage queues meetings rather than losing them, and they drain once the
credentials are right.

---

## 3. Cloudflare R2

Create a bucket named `orion` and an API token with object read/write.

- `S3_BUCKET` — **`orion`**, on **both** `orion-backend` and `orion-ai`. They
  read and write the same objects; a mismatch is not an error, it is one service
  quietly writing somewhere the other never looks.
- `S3_ENDPOINT` — `https://<account-id>.r2.cloudflarestorage.com`
- `S3_REGION` — `auto` (R2 accepts nothing else)
- `S3_PUBLIC_ENDPOINT` — the same, unless a custom domain fronts the bucket.
  Needed on **both** services. Blank on `orion-ai` does not fail; it silently
  disables AssemblyAI fetching the recording from R2 itself, so every file is
  pulled into the container and pushed out again.
- `S3_ACCESS_KEY` / `S3_SECRET_KEY` — the same token on both, and it must have
  **write**. `orion-ai` used to only read, so a token scoped to "Object Read
  only" worked there; MP3 export writes the converted copy back to the bucket,
  and a read-only token turns that into a conversion that runs, succeeds, and
  fails on the very last step, every time.

### The bucket must allow the app's origin to GET

**Required, or MP3 export silently produces nothing.** The browser now fetches
the converted recording straight from R2 with a presigned URL, so that it can go
into the same archive as the summary and the transcript. That is a cross-origin
request from the Vercel app to `*.r2.cloudflarestorage.com`, and without a CORS
rule the browser refuses it before it is sent — the API sees nothing, R2 sees
nothing, and the only evidence is a console message.

It is deliberately not proxied through Spring: an hour of audio through a
request thread is a denial-of-service tool with a login.

In the Cloudflare dashboard, **R2 → `orion` → Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": ["https://your-app.vercel.app"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": [],
    "ExposeHeaders": ["Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

- **`AllowedOrigins`** is the frontend's origin — the same value as
  `APP_FRONTEND_URL` on `orion-backend`. Add the preview origin too if MP3
  export is tested from one.
- **`AllowedHeaders` is empty on purpose.** The request carries no headers at
  all: the credential is the signature in the URL, and adding `Authorization`
  would both fall outside the signature and turn a simple GET into a preflighted
  one. Empty keeps it simple, which means no `OPTIONS` round trip per download.
- **`GET` only.** Uploads are presigned PUTs performed by the browser too, and
  if that ever needs a rule it is a separate one; nothing here needs write.

Nothing else in Orion depends on this. Document exports come from the API, and
the audio player uses a presigned URL as an element `src`, which is not a
`fetch` and is not subject to CORS.

> **Historical only.** The bucket was called `recallix` before the rename and
> its API token was scoped to that name. It is not the deployment bucket and
> nothing reads it. Buckets cannot be renamed in place, so `orion` was created
> fresh — if you still have objects in the old one, copy them across and then
> retire it. Do not point any service at `recallix`.

No code change is needed: `S3Config` already overrides the endpoint and uses
path-style addressing.

**CORS is required.** The browser uploads audio straight to the bucket with a
presigned `PUT`; without a CORS rule that upload fails in the browser while
every server-side check still passes:

Set `AllowedOrigins` to the **Vercel** origin — the same value that goes into
`APP_FRONTEND_URL`. List the preview origin too if you upload from staging.

```json
[{
  "AllowedOrigins": ["https://<your-project>.vercel.app"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

---

## 4. Clerk

**Create a production instance.** A Clerk *development* instance — the one whose
keys begin `pk_test_` / `sk_test_` and whose issuer ends `.accounts.dev` — is
not a production instance with a different name. It has its own user list, so
accounts created there do not exist in production; it has relaxed session
handling and no custom domain; and its sign-in flow depends on a dev-browser
cookie that behaves differently across sites.

The backend logs a WARNING when it sees `.accounts.dev`, and does not refuse to
start — a staging environment on a development instance is a reasonable thing to
run, and nothing here can tell staging from production.

### Two instances, two sets of users

Run staging and production against **different Clerk instances**, and know what
that costs: the user lists are separate. An account created while testing on
`dev` does not exist in production. Nobody has to migrate anything, but nobody
can sign in to production with a staging account either.

| | Staging (`dev` branch) | Production (`main` branch) |
|---|---|---|
| Clerk instance | development | production |
| Publishable key | `pk_test_…` | `pk_live_…` |
| Secret key | `sk_test_…` | `sk_live_…` |
| Issuer / JWKS | `…accounts.dev` | your production Clerk domain |
| `.accounts.dev` warning | **expected — ignore it** | must not appear |

The backend logs that warning whenever it sees `.accounts.dev` and starts
anyway, because it cannot tell staging from production. On staging that line is
correct and should be ignored; on production it means the wrong instance is
wired up.

Where each value goes:

| Variable | Set in | Notes |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | **Vercel** | build-time — inlined into the bundle |
| `CLERK_SECRET_KEY` | **Vercel** | runtime only, server-side; never `NEXT_PUBLIC_` |
| `CLERK_ISSUER` | **Render** (`orion-backend`) | |
| `CLERK_JWKS_URL` | **Render** (`orion-backend`) | |

Add the production domain to the Clerk instance once Vercel has issued it.

Add an `email` claim to the JWT template. Clerk's default session token
carries no email, and without it every Clerk-authenticated user lands with a
null address — which is the address shown on their own profile page, **and the
address every queued message is delivered to**. No longer cosmetic: seven
messages now depend on it — see section 4b below.

---

## 4b. Resend — email

Seven messages, all written to `mail_outbox` inside the transaction that caused
them and delivered later by a relay. Two have no user switch: an account closed
and its data deleted, and an allowance spent. The closure notice is the only
record of the deletion that exists once the account is gone.

Two variables, both on **Render** (`orion-backend`), both `sync: false`:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | `re_…` from the Resend dashboard |
| `ORION_MAIL_FROM` | `Recallix <notifications@yourdomain.com>` |

`ORION_MAIL_FROM` must be on a **domain verified in Resend**. `DeploymentCheck`
refuses to start on `resend.dev`, `example.*`, `localhost`, `test` and
`invalid`, because those fail at the provider rather than here — every message
is queued, retried for five hours, abandoned, and nobody is told anything.
`onboarding@resend.dev` is the sharp one: it works, and it delivers only to the
Resend account owner, so in production every closure notice reaches the
developer instead of the account holder.

### Verifying a domain

Resend will not send from a domain you have not proved you control, and there is
no free tier around that — the shared sender below is the only alternative it
offers. A `.xyz` or `.com` is roughly $1–15/year at Porkbun, Namecheap or
Cloudflare Registrar; that is the whole cost.

1. Buy the domain. Any registrar whose DNS you can edit.
2. Resend → **Domains** → **Add Domain**. Give it a **subdomain**, e.g.
   `send.yourdomain.xyz`, not the root. Sending reputation then accrues to the
   subdomain and leaves the root free for ordinary mail later.
3. Resend generates the DNS records — an `MX` for bounce feedback, a `TXT` SPF,
   and a `TXT` DKIM key at `resend._domainkey.…`. The exact values are per
   domain and per region, so copy them from the dashboard rather than from any
   example. Add them at the registrar.
4. Click **Verify**. Usually minutes; DNS can take longer.
5. Resend → **API Keys** → create one with **Sending access**. That is the
   `re_…` value.

**The from-address must be on the domain you actually verified.** Verifying
`send.yourdomain.xyz` does not verify the root — `notifications@yourdomain.xyz`
is then an unverified sender and Resend rejects it, which shows up here as
messages queued, retried and abandoned rather than as a startup failure. Match
them exactly:

```
ORION_MAIL_FROM = Recallix <notifications@send.yourdomain.xyz>
```

### No domain? Then say so, and mean it

There is a second valid mode, for a deployment whose only account is yours. It
is not a bypass — it is enforced.

| Variable | Value |
|---|---|
| `ORION_MAIL_SELF_ONLY` | `true` |
| `ORION_MAIL_SELF_USER_ID` | your Clerk user id, `user_…` |

**Both, or the service will not start.** `ORION_MAIL_SELF_ONLY=true` with a
blank id once meant "enforce nothing", which made the one setting whose job is
to restrict access silently do the opposite of what it said. `SelfOnlyAccess`
now refuses to construct in that state, so the bean fails and the container
exits 1 with the reason in the log:

```
IllegalStateException: ORION_MAIL_SELF_ONLY is true but ORION_MAIL_SELF_USER_ID is blank
```

That is this, and it is one dashboard variable away from fixed.

What it enforces: every Clerk subject other than the named one is refused at
`UserService.provision` with a 403, **before the lookup**, so no row is written
and a rejected stranger leaves nothing behind. Hiding the sign-up button would
not do — Clerk creates the account whatever Orion's UI shows, and the token it
mints is real.

With the id set, `onboarding@resend.dev` is accepted: the Resend account owner
and the only Orion account holder are the same person, so a sender that reaches
only them is correct rather than misdirected. Leaving both mail variables blank
is accepted too — nothing is delivered, messages expire unsent after ninety
days, and every boot says so in as many words.

### Getting the id, in the right order

The id is **per Clerk instance** — see "Two instances, two sets of users" above.
A `user_…` copied from the development instance will not match the production
JWT `sub`, and the symptom is not a startup failure: the service comes up and
returns 403 to you on every request. The refusal log names both ids, which is
how you tell that apart from a broken token.

If nobody has signed up on the production instance yet, there is no id to name.
Sign up first. Clerk's flow is entirely client-side and does not need the
backend, so it works while the service is down:

1. Sign up through the Vercel frontend, against the **production** Clerk
   instance. The dashboard will fail to load its data — that is the backend
   being down, and it does not matter here.
2. Clerk dashboard → **Users** → your user → copy the id (`user_…`).
3. Render → `orion-backend` → **Environment** → set `ORION_MAIL_SELF_USER_ID`.
4. Save. Render redeploys, and your first request provisions the account.

Unset `ORION_MAIL_SELF_ONLY`, and verify a domain, before anybody else is meant
to sign up. Until you do, they cannot — self-only 403s every other account at
provisioning, which is the whole point of it and exactly wrong for a deployment
you want strangers to try.

**Unset means delete the variable, not blank it.** Spring's `${VAR:false}`
default applies only when the variable is *absent*; a row that exists with an
empty value resolves to `""` and is bound in place of the default. In the Render
dashboard, remove the row.

---

## 5. Redis

None. There is no Redis to provision.

It backed one thing: a fixed-window counter in front of the streaming-token
endpoint. That counter is now a map inside the backend. The limit is unchanged
at 30 requests per user per 10 minutes, and it no longer fails open, because
there is no longer a connection that can fail.

Being in-process makes it per-instance: two backends would allow 60 requests per
user per 10 minutes rather than 30. That is the only thing left that a second
instance changes — see "What is not covered". The outbox used to be on this list
and no longer is.

**If a Redis Cloud database still exists for this project, delete it or revoke
its credentials.** Nothing has connected to it since the counter moved
in-process, and an unused datastore with live credentials is worse than one in
use: nobody is watching it.

---

## 6. Billing

There is none. Stripe checkout and its webhook were removed in V49: every
account gets the same allowance — 100 transcribed minutes and 3 imports, for the
life of the account — so there was nothing for a payment to buy.

Nothing to configure, and one fewer public unauthenticated route to reason
about. `users.plan` survives as a label on rows an earlier build created; no
code writes it and no limit reads it.

---

## 7. Vercel — the frontend

The Next.js app is deployed on Vercel. It is **not** in `render.yaml`, and none
of the variables below are set through it. They live in the Vercel project's
Environment Variables, per environment.

### Required

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | public **HTTPS** Render backend URL | e.g. `https://orion-backend.onrender.com` |
| `NEXT_PUBLIC_WS_URL` | public **WSS** backend socket URL | e.g. `wss://orion-backend.onrender.com/ws` |
| `NEXT_PUBLIC_AUTH_MODE` | `clerk` | never `dev` — that mode trusts an `X-Dev-User` header |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_…` staging / `pk_live_…` production | |
| `CLERK_SECRET_KEY` | `sk_test_…` staging / `sk_live_…` production | **server-side only**, never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` | |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` | |

`wss://`, not `https://`, on the socket URL, and it keeps the `/ws` path. And
both URLs need the scheme: a scheme-less `NEXT_PUBLIC_API_URL` is read as a
relative path, so the app calls *itself* instead of the API and every request
404s from the frontend's own origin.

Without the two `SIGN_IN`/`SIGN_UP` URLs, Clerk's components link to its hosted
pages on `accounts.dev` — a different domain, a different look, and a route out
of the product to get back into it. Orion serves both screens itself.

### Optional

None of these break anything when unset; they are listed so "the footer looks
wrong" is a five-second fix rather than a hunt.

| Variable | Effect when unset |
|---|---|
| `NEXT_PUBLIC_APP_VERSION` | footer shows no version |
| `NEXT_PUBLIC_BUILD_SHA` | footer reads "dev build" rather than inventing a hash |
| `NEXT_PUBLIC_TERMS_URL` | the link is not rendered |
| `NEXT_PUBLIC_PRIVACY_URL` | the link is not rendered |

### Every `NEXT_PUBLIC_*` is a BUILD-time value

`next build` inlines them into the client bundle. They are not read at runtime.
Change one and you must trigger a **new deployment** — editing the variable in
the Vercel dashboard and redeploying the *existing* build changes nothing, and
the old value keeps being served. This is the single most common way to spend an
afternoon on a variable that was correct in the dashboard the whole time.

`CLERK_SECRET_KEY` is the exception: it is read at runtime by `middleware.ts`,
in Node, on the server.

### Branch model

| Branch | Vercel environment |
|---|---|
| `dev` | Preview / staging deployment |
| `main` | Production deployment |

`main` does not exist yet — production is not deployed. Point the staging
frontend at the staging backend and the staging Clerk instance; keep production
values in Vercel's Production environment only, so a preview build cannot pick
up a `sk_live_` key.

---

## 8. Render — two services

`render.yaml` declares exactly two, and no frontend:

| Service | Type | Public? | Runs |
|---|---|---|---|
| `orion-backend` | `web` | yes | Spring Boot, Flyway migrations, `production` profile |
| `orion-ai` | `pserv` | **no** | FastAPI worker, Kafka consumer |

```bash
# from the repo root, on the branch you want live
render blueprint launch     # or point the dashboard at render.yaml
```

### Branch model

| Branch | Render services |
|---|---|
| `dev` | staging backend + AI, deployed first |
| `main` | production backend + AI, later |

`main` does not exist yet, so **nothing is in production**. Everything below
describes bringing staging up from `dev`.

Fill every `sync: false` value in the dashboard before the first build.
`ORION_INTERNAL_TOKEN` is generated on the backend and referenced by the
ai-service, so the two always match — do not set it by hand on one side only,
or every worker callback returns 401.

If any of them is missed, the backend will not start: `DeploymentCheck` lists
every development setting it found and refuses. That is the intended outcome —
it is a bad ten minutes rather than a deployment that is open, or broken, and
looks fine. The message names each variable and what it costs.

### Order matters on first boot

The backend runs migrations, so let it come up first and confirm
`/actuator/health` is `UP`. The ai-service degrades rather than crashes when
Kafka or Postgres is unreachable, which means it can look healthy while doing
nothing — check its logs for `RAG connected to Postgres` rather than trusting
the service status.

---

## 9. Deployment order

### The one circular dependency

The frontend needs the backend's URL at **build** time. The backend needs the
frontend's origin for CORS and for the STOMP allowed-origins check. Neither host
will tell you its URL before the service exists, so this cannot be done in one
pass.

It resolves because only one side needs its value *up front*:

```
backend deployed  ->  URL exists  ->  frontend built with it
                                          |
                                          v
                                    Vercel URL exists
                                          |
                                          v
                      APP_FRONTEND_URL filled -> backend RESTARTED
```

The backend is deployed with `APP_FRONTEND_URL` still blank. `DeploymentCheck`
will refuse to start on a blank value, so put a placeholder origin in — any
`https://` URL — bring it up, get the Vercel URL, then replace the placeholder
and restart. A **restart** is enough on the backend: `APP_FRONTEND_URL` is read
at runtime. The frontend needs a full **rebuild**, because its variables are
inlined.

### Steps

1. **Provision the managed dependencies** — Neon (sections 1), Confluent (2),
   R2 (3), Clerk (4). Nothing deploys until these exist.
2. **Deploy the Render staging services from `dev`** — `orion-backend` and
   `orion-ai`. `APP_FRONTEND_URL` gets a placeholder for now.
3. **Take the public backend URL**, e.g. `https://orion-backend.onrender.com`.
   Confirm `/actuator/health` is `UP` before going further.
4. **Configure the Vercel Preview environment** — every variable in section 7,
   with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` built from step 3, and
   the **development** Clerk keys.
5. **Deploy the frontend from `dev`** and take its URL, e.g.
   `https://<your-project>.vercel.app`.
6. **Put that URL into `APP_FRONTEND_URL`** on `orion-backend`. Add it to the
   R2 CORS `AllowedOrigins` (section 3) and to the Clerk instance's allowed
   domains at the same time — all three want the same value, and forgetting the
   R2 one fails only at upload.
7. **Restart `orion-backend`** so it picks the value up.
8. **Run the end-to-end staging checks**: sign in, record and upload a meeting,
   watch the status arrive over the socket, open the finished summary, ask the
   chat a question, export. Each exercises a different one of the four
   dependencies, which is the point of doing all five rather than just the
   first.
9. **Only then create `main`** and repeat 2–8 with the production Clerk
   instance, production Vercel environment, and a fresh `ORION_INTERNAL_TOKEN`.

Steps 6 and 7 are the ones people skip, because the frontend loads fine without
them — it is every API call behind it that fails, which reads as "the backend is
down".

---

## What is not covered

- **No CI.** Nothing runs the backend or ai-service suites before a deploy.
  This blueprint deploys whatever is on the branch.
- **No bounce handling.** Resend accepting the message is where Orion's
  knowledge ends. A hard bounce, a spam complaint, or an address that stopped
  existing is not fed back: the row is marked sent and nothing reconciles it.
  There is no webhook endpoint to point Resend at.
- **Mail delivery is at-least-once, not exactly-once.** The relay claims rows
  with `FOR UPDATE SKIP LOCKED` and sends each one under a dedupe key passed as
  Resend's `Idempotency-Key`, which Resend honours for **24 hours**. Every
  automatic retry happens well inside that window, so it cannot duplicate. An
  operator who manually replays an abandoned row *after* the window can, and
  there is nothing provider-side to prevent it.
- **Rate limiting is per-instance.** The streaming-token counter is a map in
  the backend, so two instances allow twice the limit. It is burst protection
  rather than a quota — the thing that actually costs money is the AI-minute
  allowance, which is a database row and unaffected — but it is the one piece of
  correctness that a second backend changes.

  The outbox is no longer on this list. `OutboxPublisher.publishBatch()` claims
  its rows with `FOR UPDATE SKIP LOCKED`, so two backends divide the backlog
  instead of both publishing it; proven against a real PostgreSQL in
  `OutboxClaimConcurrencyTest` and against two live containers.

- **One Kafka partition, one AI worker.** `meeting_uploaded` has a single
  partition and the worker consumes it serially, so one slow meeting delays
  every meeting behind it and a second worker would idle. More partitions is
  the change, and it is a Confluent-side change first.

- **No consumer-lag alert.** With one partition and one worker there is nothing
  that notices a stuck message except somebody looking. Configure one in
  Confluent Cloud: consumer group `ai-service`, topic `meeting_uploaded`, alert
  when lag stays above 5 for 15 minutes.
- **No backup policy** beyond whatever the Neon plan provides.
