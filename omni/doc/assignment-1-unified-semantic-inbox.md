# Assignment 1: Unified Semantic Inbox

This document answers the three required parts in the `Assignment` section:

1. Architecture diagram + thundering herd handling
2. MongoDB schema with Bucket Pattern
3. AI layer design with Semantic Caching

---

## 1) The Architecture

### 1.1 High-level architecture diagram

```mermaid
flowchart LR
    A1[LINE Webhook] --> B[API Gateway / Ingress]
    A2[WhatsApp Webhook] --> B
    B --> C[Webhook Receiver Service]
    C --> D{Idempotency Check<br/>(provider + delivery_id)}
    D -->|Duplicate| E[Return 200 + drop]
    D -->|New Event| F[Publish to Message Queue]
    F --> G[Intent Engine Workers<br/>(Java 21 Virtual Threads<br/>or Kotlin Coroutines)]
    G --> H[Identity Resolver]
    H --> I[(MongoDB user_identity_map)]
    G --> J[Context Reader]
    J --> K[(MongoDB message_buckets)]
    G --> L[Semantic Cache Lookup<br/>(Redis + embeddings)]
    L -->|Cache Hit| M[Intent Decision]
    L -->|Cache Miss| N[LLM Classifier<br/>(OpenAI/Claude)]
    N --> O[Cache Write]
    O --> M
    M --> P[Persist Result + Message]
    P --> K
    M --> Q[Downstream Router<br/>(Support / Sales / Spam)]
    C --> R[Fast ACK 200]
```

### 1.2 Thundering herd strategy (10,000 concurrent webhooks/sec)

The system absorbs burst traffic by making webhook ingestion very lightweight and moving heavy operations behind a queue.

- **Fast ACK at edge:** webhook receiver validates signature and idempotency key, then returns `200` immediately.
- **Queue decoupling:** expensive steps (identity resolution, context fetch, LLM call, write-back) run asynchronously from queue consumers.
- **Per-conversation ordering:** queue key/partition by `canonical_user_id` or `conversation_id` to keep message order where needed.
- **Bounded concurrency:** workers use virtual threads/coroutines for high I/O parallelism, but enforce strict limits for:
  - Mongo connection pool usage
  - LLM in-flight requests
  - Per-tenant request budget
- **Backpressure controls:** when downstream is slow, queue depth grows while webhook edge still stays responsive.
- **Idempotency and retries:** provider retries are safe due to dedupe key `(provider, delivery_id)`; failures go through retry policy and DLQ.
- **Circuit breaker + fallback:** if LLM provider latency spikes, route low-risk patterns (greetings/thanks) through semantic cache and heuristic defaults.

### 1.3 Stateless Intent Engine principles

“Stateless” means worker processes do not keep conversation state in memory between requests.

- All durable state lives in MongoDB.
- Repeated inference results live in semantic cache.
- Any worker instance can process any event, enabling horizontal scale.

---

## 2) The Schema (MongoDB Bucket Pattern)

### 2.1 Collections

#### `user_identity_map`
Resolves user across LINE/WhatsApp into one canonical identity.

Example document:

```json
{
  "_id": "usr_7f9e",
  "canonical_user_id": "usr_7f9e",
  "linked_accounts": [
    { "provider": "line", "provider_user_id": "Uabc123" },
    { "provider": "whatsapp", "provider_user_id": "15551234567" }
  ],
  "created_at": "2026-04-07T09:00:00Z",
  "updated_at": "2026-04-07T10:30:00Z"
}
```

Indexes:

- `{ "linked_accounts.provider": 1, "linked_accounts.provider_user_id": 1 }` (lookup by incoming webhook user)
- `{ "canonical_user_id": 1 }`

#### `conversations`
Small metadata docs per logical conversation.

Example document:

```json
{
  "_id": "conv_92a1",
  "canonical_user_id": "usr_7f9e",
  "channel_set": ["line", "whatsapp"],
  "status": "active",
  "last_message_ts": "2026-04-07T10:35:21Z",
  "active_bucket_id": "conv_92a1_202604071035"
}
```

Indexes:

- `{ "canonical_user_id": 1, "last_message_ts": -1 }`
- `{ "status": 1, "last_message_ts": -1 }`

#### `message_buckets` (Bucket Pattern)
Each document stores a bounded window of messages to avoid unbounded growth.

Example document:

```json
{
  "_id": "conv_92a1_202604071035",
  "conversation_id": "conv_92a1",
  "canonical_user_id": "usr_7f9e",
  "bucket_start_ts": "2026-04-07T10:35:00Z",
  "bucket_end_ts": "2026-04-07T10:39:59Z",
  "message_count": 42,
  "messages": [
    {
      "message_id": "msg_1",
      "provider": "line",
      "provider_delivery_id": "line_did_abc",
      "ts": "2026-04-07T10:35:21Z",
      "direction": "inbound",
      "text": "Hello",
      "intent": "Support",
      "intent_confidence": 0.93
    }
  ],
  "created_at": "2026-04-07T10:35:00Z",
  "updated_at": "2026-04-07T10:35:22Z"
}
```

Recommended bucket rollover policy:

- **Time-based:** every 5 minutes, or
- **Size-based:** every N messages (e.g., 100), whichever comes first.

Indexes:

- `{ "conversation_id": 1, "bucket_end_ts": -1 }` (fetch latest buckets quickly)
- `{ "canonical_user_id": 1, "bucket_end_ts": -1 }`
- Optional sparse index on `"messages.provider_delivery_id"` for forensic/debug queries

### 2.2 Query for “last 5 minutes context in under 100ms”

Query strategy:

1. Resolve `canonical_user_id` from `user_identity_map`.
2. Resolve current `conversation_id`.
3. Read only recent buckets:
   - `find({ conversation_id, bucket_end_ts: { $gte: now - 5m } })`
   - sort `bucket_end_ts` descending
   - project only `messages.ts`, `messages.text`, `messages.intent` fields
4. In application layer, filter messages `ts >= now - 5m`.

Why this meets latency target:

- Reads touch only 1-2 small recent bucket docs in the common case.
- Covered by compound index on `(conversation_id, bucket_end_ts)`.
- Narrow projection reduces BSON transfer and decode cost.

---

## 3) The AI Layer (Semantic Caching)

### 3.1 Objective

Avoid repeated LLM calls for semantically equivalent low-value messages such as:

- “hello”, “hi”, “hey there”
- “thanks”, “thank you”, “thx”

### 3.2 Flow

1. Normalize incoming text (lowercase, trim, punctuation cleanup, optional locale normalization).
2. Generate lightweight embedding for normalized text.
3. Query semantic cache with:
   - similarity threshold (e.g., cosine >= 0.92)
   - same tenant and language constraints
4. If hit:
   - reuse cached intent + confidence + rationale metadata
   - skip LLM
5. If miss:
   - call LLM classifier
   - persist result
   - write to semantic cache with TTL

### 3.3 Cache key/value model

Key dimensions:

- `tenant_id`
- `language`
- `intent_model_version` (invalidates cache when prompt/model changes)
- vector embedding index entry

Cached value:

- `intent` (`Support` | `Sales` | `Spam`)
- `confidence`
- `source_text_sample`
- `created_at`, `ttl_expires_at`
- optional `usage_count` for analytics

### 3.4 Guardrails

- Never reuse cache if similarity below threshold.
- Shorter TTL for ambiguous intents.
- Bypass cache for policy-sensitive inputs (PII/security markers).
- Periodic quality audit: sample cache hits and compare with fresh LLM inference.

### 3.5 Expected impact

- Reduced LLM call volume on repetitive traffic.
- Lower p95/p99 classification latency.
- Better resilience during LLM provider degradation.

---

## Operational Notes (recommended but optional for assignment)

- **Observability:** track `webhook_ack_latency`, queue lag, cache hit ratio, LLM timeout rate, context-query p95.
- **Reliability:** DLQ + replay tools for failed events.
- **Security:** verify webhook signatures, redact/hashed PII in logs, encrypt sensitive fields at rest.

This design provides a stateless, burst-tolerant pipeline with predictable MongoDB read performance and practical LLM cost control via semantic caching.

---

## 4) Assignment 2 Plan: The "Self-Correction Pipeline" (Vibe Coding & Startup Execution)

### 4.1 MVP goal (what must work)
1. Receive a WhatsApp message event.
2. Run an AI classifier that extracts:
   - `user_sentiment`
   - `product_interest`
3. Allow a human agent to override the extracted sentiment/interest.
4. When the override is written, MongoDB Change Streams trigger a `Critic Agent`.
5. The Critic Agent explains why the first AI output was wrong and updates `Prompt Context` to improve future runs.

### 4.2 Proposed system design (minimal components)
1. `ingestion` service (API)
   - Endpoint to ingest a WhatsApp message (or accept a test payload).
   - Persists the message and the first-pass AI extraction result.
2. `human_override` endpoint (API)
   - Endpoint for an operator to override fields in the stored extraction.
   - Writes the override result in MongoDB.
3. `critic_worker` (background process)
   - Watches MongoDB Change Stream for override events.
   - Fetches:
     - original message text
     - first-pass extraction output
     - the override values
     - current `prompt_context` snapshot/version
   - Calls the critic LLM with a structured rubric.
   - Writes an updated `prompt_context` version and marks the override as “critic_applied”.

### 4.3 MongoDB data model (keep it simple, extensible)
Collections (suggested):
1. `whatsapp_messages`
   - `_id`
   - `provider` (e.g., `whatsapp`)
   - `provider_message_id`
   - `conversation_id` (optional, if you want continuity)
   - `text`
   - `created_at`
2. `extraction_results`
   - `_id`
   - `message_id` (FK to `whatsapp_messages`)
   - `ai_version` (model + prompt template version)
   - `user_sentiment` (AI output)
   - `product_interest` (AI output)
   - `confidence` (optional but helpful)
   - `created_at`
3. `human_overrides`
   - `_id`
   - `message_id` / `extraction_result_id`
   - `overridden_user_sentiment`
   - `overridden_product_interest`
   - `overrode_by` (operator id or “system” for demo)
   - `created_at`
   - `critic_applied` (boolean)
   - `critic_context_version_used` (optional)
4. `prompt_context`
   - `_id` (singleton doc or versioned docs)
   - `context_version` (integer / semver)
   - `prompt_context_text` (rubrics, constraints, few-shot examples, do/don’t)
   - `created_at`
   - `metrics` (optional: last update time, observed improvement, etc.)

Change stream target:
- Watch `human_overrides` for inserts/updates where `critic_applied = false`.

### 4.4 Workflow (exact sequence to implement)
1. Ingest message
   - `POST /messages/whatsapp`
   - Store message in `whatsapp_messages`.
2. First-pass extraction
   - Read latest `prompt_context` (or default prompt if none exists).
   - Run `extract(user_text, prompt_context)`.
   - Store result in `extraction_results` with `ai_version`.
3. Human override
   - `POST /messages/:id/override`
   - Update/insert into `human_overrides` with override values.
4. Critic trigger
   - `critic_worker` Change Stream sees new override event (or update).
   - Deduplicate by override `_id` so you don’t run critic twice.
5. Critic analysis + prompt update
   - Provide critic with:
     - original message text
     - AI outputs (sentiment/interest)
     - overridden correct labels
     - current prompt context
   - Ask critic to output:
     - “what went wrong” (short explanation)
     - “rule changes” to improve extraction next time
     - “updated prompt context” in a deterministic, structured format
   - Write:
     - new `prompt_context` version
     - set `critic_applied=true` for the override.

### 4.5 Cost control (business logic so critic is worth it)
Guardrails to prevent runaway cost:
1. Only run critic on “real overrides”
   - If no human override, do not critic.
2. Run critic conditionally using confidence/heuristics
   - Example: only critic when first-pass `confidence` is low OR predicted sentiment conflicts with keyword heuristics (optional).
3. Sample overrides
   - For high-volume environments, run critic for only `N%` of overrides, or for those above a “impact” threshold.
4. Hard budgets
   - Max tokens for critic prompts.
   - Rate limit critic worker per minute.
5. Deduplicate critic work
   - Ensure each override triggers critic exactly once (`critic_applied` guard).
6. Measure improvement over time
   - Track:
     - override rate per label category before/after prompt updates
     - sample quality drift (spot checks)
   - Stop/rollback prompt updates if improvement is not observed after K critic runs.

Simple cost-benefit narrative for the write-up:
- Critic cost is proportional to override events; value increases if critic reduces future overrides (higher precision).
- The system self-limits because critic only triggers from human corrections, and it updates a shared prompt context that amortizes learning across all future messages.

### 4.6 “Push factor” (deploy in 24 hours)
1. Day 1, minimal infra
   - MongoDB Atlas (preferably serverless for quick setup).
   - Deploy API service (any simple platform: Render/Fly/Vercel; if Kotlin, deploy a lightweight container).
2. Environment setup
   - `MONGODB_URI`
   - `OPENAI_API_KEY` (or your LLM provider)
   - `AI_MODELS` (extraction vs critic model names)
3. Implement a single runnable entrypoint
   - `docker-compose` optional for local dev.
   - In production, run:
     - web server for ingestion/override endpoints
     - critic worker as the same process (separate instance is fine for scaling)
4. Demo scripts
   - `POST /messages/whatsapp` with sample texts.
   - `POST /messages/:id/override` to simulate human correction.
   - Verify critic updates `prompt_context` and sets `critic_applied`.

If you want to follow the prompt’s example: wrap the service as a small Ktor app around MongoDB + a background change-stream coroutine.

### 4.7 Implementation plan (repo checklist)
1. Repo scaffold
   - `src/` for API + AI extraction + critic worker
   - `scripts/` for demo commands
   - `docs/` for the write-up and run instructions
2. AI prompt templates
   - `extract_prompt` (uses `prompt_context_text` + output schema)
   - `critic_prompt` (compares AI output vs override and outputs updated context)
3. Local dev mode (so it “runs” even without LLM keys)
   - Add a `MOCK_LLM=true` flag to return deterministic outputs for demo/testing.
4. Tests (minimal but meaningful)
   - Unit tests for:
     - normalization
     - JSON schema parsing/validation
     - critic dedup logic (override -> single critic run)
   - Integration test:
     - insert message -> insert override -> confirm prompt_context version increment
5. Observability
   - Log:
     - message_id, ai_version, prompt_context_version
     - critic worker start/finish
     - override applied -> critic_applied

### 4.8 What “good” looks like in the submission
1. A runnable repo with clear commands:
   - `npm run dev` / `./gradlew run` (whatever your stack is)
   - show endpoints + example payloads
2. A clear explanation of:
   - how Change Streams trigger the critic
   - how prompt_context updates are versioned
   - how you control critic spend (budgets, sampling, and measurement)
3. A short demo narrative:
   - “message A” extracted wrongly, operator overrides, critic updates prompt context, “message B” improves.
