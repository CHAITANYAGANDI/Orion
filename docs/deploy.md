# Deploying Recallix

Target: **Render** for the three services, with **Neon** (Postgres), **Confluent
Cloud** (Kafka), **Cloudflare R2** (object storage) and a managed **Redis**.

[`render.yaml`](../render.yaml) declares the services. It cannot do the one-time
provisioning below, and several steps here are the difference between a
deployment that works and one that comes up healthy while being silently wrong.

---

## 0. Before anything: the two failure modes that do not announce themselves

**Auth mode.** `RECALLIX_AUTH_MODE` defaults to `dev` everywhere. In dev mode
`AuthenticationFilter` trusts an `X-Dev-User` header, so *any* request can
impersonate *any* user. A deployment that misses this variable is completely
open **and behaves perfectly** — nothing in the logs or the UI reveals it. The
blueprint hardcodes `clerk`; do not override it.

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

Only **one** of the eight topics is load-bearing. `meeting_uploaded` carries job
dispatch from the backend's outbox to the ai-service worker; break it and nothing
transcribes. The other seven are consumed by `KafkaStatusConsumer`, which only
logs — the status updates the UI actually shows travel over the internal HTTP
callbacks, not Kafka. Worth knowing when you are deciding how much to spend here.

### Create the cluster

A **Basic** cluster in the region nearest the Render services. Basic bills on
consumption and costs nothing at rest, which for one message per meeting is the
right shape.

### Create the topics

Create all eight with **1 partition** each, leaving the replication factor at the
default:

```
meeting_uploaded            transcription_started      transcription_completed
summary_generated           action_items_extracted     meeting_processing_failed
payment_successful          usage_limit_reached
```

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

Set the instance to production, add the frontend domain, and take:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (frontend, **build-time**)
- `CLERK_ISSUER` and `CLERK_JWKS_URL` (backend)

If recap email should address users automatically, add an `email` claim to the
JWT template — Clerk's default session token carries no email, and without it
every Clerk-authenticated user lands with a null address and recaps quietly do
not send.

---

## 5. Redis

Set `SPRING_DATA_REDIS_URL` to the `rediss://` URL. Boot parses host, port,
password and TLS from it and ignores the `SPRING_DATA_REDIS_HOST`/`PORT` pair.

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

### Order matters on first boot

The backend runs migrations, so let it come up first and confirm
`/actuator/health` is `UP`. The ai-service degrades rather than crashes when
Kafka or Postgres is unreachable, which means it can look healthy while doing
nothing — check its logs for `RAG connected to Postgres` rather than trusting
the service status.

---

## What is not covered

- **No CI.** Nothing runs the 156 backend tests or the ai-service suite before a
  deploy. This blueprint deploys whatever is on the branch.
- **No SMTP relay.** `RECALLIX_MAIL_ENABLED` is `false`; recap email is off until
  a relay exists.
- **The backend must run as a single instance.** `OutboxPublisher.publishBatch()`
  selects unpublished rows with a plain ordered query — no `FOR UPDATE SKIP
  LOCKED`, no row lock. Two instances would select the same batch and both
  publish it, so every event reaches Kafka twice and the pipeline pays for the
  transcription twice. Scaling the backend horizontally needs that query to
  claim rows first; until then, keep it at one instance.
- **No backup policy** beyond whatever the Neon plan provides.
