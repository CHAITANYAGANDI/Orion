# Deploying Recallix

Target: **Render** for the three services, with **Neon** (Postgres), **Confluent
Cloud** (Kafka) and **Cloudflare R2** (object storage).

[`render.yaml`](../render.yaml) declares the services. It cannot do the one-time
provisioning below, and several steps here are the difference between a
deployment that works and one that comes up healthy while being silently wrong.

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

**Auth mode.** `RECALLIX_AUTH_MODE` defaults to `clerk`, in `application.yml`
and on every `@Value` that reads it. In dev mode `AuthenticationFilter` and
`StompAuthInterceptor` trust an `X-Dev-User` header, so *any* request — and any
websocket — can impersonate *any* user. The blueprint hardcodes `clerk`; do not
override it.

> It defaulted to `dev` until recently, and the fail-closed default written on
> the `@Value` was cancelled by `application.yml` supplying `dev` explicitly — a
> `@Value` default applies only when a property is *absent*. Two defaults for
> one decision, and the weaker one won silently. `ApplicationDefaultsTest` now
> resolves the real YAML with an empty environment and pins the answer.

**The internal callback token.** `RECALLIX_INTERNAL_TOKEN` has **no default**.
It used to fall back to `dev-internal-token`, which is committed to this
repository and printed further down this page, so a deployment that never set it
looked exactly like one that did — while accepting result callbacks from anybody
who had read the source. Those callbacks write transcripts and mark meetings
READY. Unset now means `InternalTokenFilter` refuses every `/internal/**`
request: meetings pile up in PROCESSING and the ai-service logs 401s, which is
loud and traceable in a way that silent acceptance is not.

**URLs that have no scheme.** Render's blueprint cannot produce a URL.
`fromService` with `property: host` yields a bare `recallix-backend.onrender.com`,
and a bare host is not an origin — CORS compares it against the browser's
`https://…` and never matches, so every request fails and it reads as "the API
is down". `APP_FRONTEND_URL`, `APP_PUBLIC_URL`, `SPRING_CALLBACK_URL` and
`NEXT_PUBLIC_API_URL` are therefore `sync: false` and filled in by hand, with
the scheme. `AI_SERVICE_URL` is the one exception: it names a private service,
where `http` is the only possibility, so `AiClient` supplies it.

**`APP_PUBLIC_URL` is not the frontend URL.** It is where *this API* is
reachable from the public internet, and only the calendar feed uses it — fetched
by Google's and Apple's servers rather than by the user's browser. It was
missing from the blueprint entirely, so it fell back to `http://localhost:8080`
and every subscribed calendar quietly stopped updating. Nothing in the app shows
this; the feed simply never refreshes.

**Frontend build-time values.** `NEXT_PUBLIC_*` are inlined into the client
bundle by `next build`, not read at runtime. Change one and you must *rebuild*,
not restart — a restart-only redeploy silently keeps serving the old bundle
pointing at the old API URL.

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
| Runtime (`SPRING_DATASOURCE_URL`, `PG_HOST`) | pooled | many short connections |
| Migrations (`FLYWAY_URL`) | **direct** | Flyway holds an advisory lock across several transactions; a transaction-mode pooler will not keep it |

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
endpoint. It creates `recallix_app` (no bypass — every user request) and
`recallix_sys` (`BYPASSRLS` — outbox relay, worker callbacks,
share links, provisioning).

Change the two passwords from the development defaults first; they are what
`SPRING_DATASOURCE_PASSWORD` and `RECALLIX_DATASOURCE_SYSTEM_PASSWORD` must be
set to.

### 1.4 Migrate

The backend runs Flyway on boot, so the first deploy migrates. `V2` issues
`CREATE EXTENSION IF NOT EXISTS vector` — `vector` 0.8.1 is available on the
instance but not yet installed, and `neondb_owner` may create it.

Note the version gap: local development runs Postgres **16**, Neon serves
**18.4**. The migrations use nothing version-specific, but this is the first
place to look if one behaves differently than it did locally.

### 1.5 Verify isolation actually survived the move

Do not skip this. Connect as `recallix_app` and confirm the tenant boundary
holds on the real database:

```sql
SET app.user_id = '<some real user id>';
SELECT count(*) FROM meetings;          -- only that user's rows
SELECT set_config('app.bypass','on',false);
SELECT count(*) FROM meetings;          -- MUST be unchanged
SELECT count(*) FROM outbox_events;     -- MUST be 0
ALTER ROLE recallix_app BYPASSRLS;      -- MUST be denied
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
topics plus the `recallix-backend` and `ai-service` consumer groups). **The
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

Create a bucket named `recallix` and an API token with object read/write.

- `S3_ENDPOINT` — `https://<account-id>.r2.cloudflarestorage.com`
- `S3_REGION` — `auto` (R2 accepts nothing else)
- `S3_PUBLIC_ENDPOINT` — the same, unless a custom domain fronts the bucket

No code change is needed: `S3Config` already overrides the endpoint and uses
path-style addressing.

**CORS is required.** The browser uploads audio straight to the bucket with a
presigned `PUT`; without a CORS rule that upload fails in the browser while
every server-side check still passes:

```json
[{
  "AllowedOrigins": ["https://<your-frontend-host>"],
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

Set the instance to production, add the frontend domain, and take:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (frontend, **build-time** — `pk_live_…`)
- `CLERK_SECRET_KEY` (frontend service, **runtime only** — `middleware.ts` runs
  in Node and verifies the session before a page is sent. It must never be a
  `NEXT_PUBLIC_` name, which would inline it into the browser bundle.)
- `CLERK_ISSUER` and `CLERK_JWKS_URL` (backend)

Add an `email` claim to the JWT template. Clerk's default session token
carries no email, and without it every Clerk-authenticated user lands with a
null address — which is the address shown on their own profile page. Nothing is
mailed to it either way; Recallix sends no email (V56).

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

## 7. Deploy

```bash
# from the repo root, on the branch you want live
render blueprint launch     # or point the dashboard at render.yaml
```

Fill every `sync: false` value in the dashboard before the first build.
`RECALLIX_INTERNAL_TOKEN` is generated on the backend and referenced by the
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

## What is not covered

- **No CI.** Nothing runs the backend or ai-service suites before a deploy.
  This blueprint deploys whatever is on the branch.
- **No email.** Not "not configured" — not implemented. Every sender was
  removed in V56, so there is no relay to provision and nothing that degrades
  without one.
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
