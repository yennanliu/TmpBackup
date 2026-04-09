# Assignment 1: Unified Semantic Inbox

## Overview

A stateless intent engine that receives webhooks from LINE and WhatsApp, resolves user identity across platforms, and classifies messages as **Support**, **Sales**, or **Spam** using an LLM — with semantic caching to minimize redundant calls.

**Constraints:** 10,000 concurrent webhooks/sec, last-5-min context retrieval in < 100ms.

---

## 1. Architecture

```
                  ┌──────────┐
   LINE ─────────▶│          │       ┌─────────────┐     ┌──────────────────┐
                  │  Ingress │──────▶│ Message Queue│────▶│  Intent Workers  │
WhatsApp ────────▶│ (ACK 200)│       │ (Kafka/SQS) │     │ (Virtual Threads)│
                  └──────────┘       └─────────────┘     └────────┬─────────┘
                       │                                          │
                       │ idempotency                   ┌──────────┼──────────┐
                       │ check (Redis)                 │          │          │
                       ▼                               ▼          ▼          ▼
                  ┌──────────┐                   ┌─────────┐ ┌────────┐ ┌────────┐
                  │ Dedup    │                   │Identity │ │Context │ │Classify│
                  │ Store    │                   │Resolver │ │Reader  │ │(Cache  │
                  │ (Redis)  │                   │         │ │        │ │ → LLM) │
                  └──────────┘                   └────┬────┘ └───┬───┘ └───┬────┘
                                                      │         │         │
                                                      ▼         ▼         ▼
                                                 ┌────────────────────────────┐
                                                 │         MongoDB            │
                                                 │  user_identity_map         │
                                                 │  message_buckets           │
                                                 └────────────────────────────┘
                                                              │
                                                              ▼
                                                 ┌────────────────────────────┐
                                                 │   Downstream Router        │
                                                 │  Support │ Sales │ Spam    │
                                                 └────────────────────────────┘
```

### Thundering Herd Strategy

The key insight: **decouple ingestion from processing**.

1. **Fast ACK** — The ingress layer validates the webhook signature, checks an idempotency key `(provider, delivery_id)` in Redis, publishes to the queue, and returns `200`. This is sub-millisecond work.
2. **Queue absorption** — Kafka (or SQS) absorbs burst traffic. Partitioned by `canonical_user_id` to preserve per-conversation ordering.
3. **Elastic workers** — Java 21 virtual threads (or Kotlin coroutines) give high I/O concurrency without thread-pool exhaustion. Workers pull from the queue at a controlled rate.
4. **Bounded concurrency** — Semaphores cap in-flight LLM requests and MongoDB connections. When limits are hit, backpressure naturally grows the queue depth while the ingress stays responsive.
5. **Circuit breaker** — If LLM latency spikes, fall back to semantic cache + heuristic defaults for low-risk patterns.

### Why Stateless

Workers hold no conversation state in memory. All state lives in MongoDB. Any worker can process any event. Horizontal scaling is trivial.

---

## 2. MongoDB Schema (Bucket Pattern)

### `user_identity_map`

Maps platform-specific IDs to one canonical user.

```json
{
  "_id": "usr_7f9e",
  "linked_accounts": [
    { "provider": "line",     "provider_user_id": "Uabc123" },
    { "provider": "whatsapp", "provider_user_id": "15551234567" }
  ],
  "updated_at": "2026-04-07T10:30:00Z"
}
```

Index: `{ "linked_accounts.provider": 1, "linked_accounts.provider_user_id": 1 }` — unique compound.

### `message_buckets` (Bucket Pattern)

Each document holds a bounded window of messages to prevent unbounded document growth.

```json
{
  "_id": "conv_92a1_bucket_003",
  "conversation_id": "conv_92a1",
  "canonical_user_id": "usr_7f9e",
  "bucket_start_ts": "2026-04-07T10:35:00Z",
  "bucket_end_ts":   "2026-04-07T10:39:59Z",
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
  ]
}
```

**Rollover policy:** new bucket every **5 minutes** or **100 messages**, whichever first.

Index: `{ "conversation_id": 1, "bucket_end_ts": -1 }`

### Querying Last 5 Minutes of Context (< 100ms)

```javascript
db.message_buckets.find({
  conversation_id: "conv_92a1",
  bucket_end_ts: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
}).sort({ bucket_end_ts: -1 })
  .project({ "messages.ts": 1, "messages.text": 1, "messages.intent": 1 })
```

This touches **1–2 documents** in the common case, covered by the compound index. Application-side filter trims to the exact 5-minute window. With narrow projection and small docs, this consistently returns in single-digit milliseconds.

---

## 3. AI Layer (Semantic Caching)

### Problem

Many incoming messages are semantically identical — "hello", "hi there", "hey", "thanks", "thx", "thank you". Calling the LLM for each is wasteful.

### Solution

```
Incoming text
     │
     ▼
┌──────────┐     ┌──────────────┐
│Normalize │────▶│  Embed       │
│(lower,   │     │  (lightweight│
│ trim)    │     │   model)     │
└──────────┘     └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │ Vector Search│  cosine >= 0.92?
                 │ (Redis VSS)  │
                 └──────┬───────┘
                   hit/ │ \miss
                  ┌─────┘  └─────┐
                  ▼              ▼
           Return cached    Call LLM
           intent           → cache result
```

### Cache Structure

| Field | Purpose |
|-------|---------|
| `embedding` | Vector for similarity search |
| `intent` | Support / Sales / Spam |
| `confidence` | LLM's confidence score |
| `model_version` | Invalidates cache on model/prompt change |
| `ttl` | Auto-expire (e.g., 24h) |

### Guardrails

- **Similarity threshold** (0.92 cosine) — prevents false matches on ambiguous text.
- **Model version key** — cache auto-invalidates when prompt or model changes.
- **TTL** — stale entries expire; shorter TTL for low-confidence results.
- **Bypass for sensitive input** — messages flagged with PII markers skip cache entirely.
- **Quality audit** — periodically sample cache hits and compare against fresh LLM inference to detect drift.

### Expected Impact

| Metric | Without cache | With cache |
|--------|--------------|------------|
| LLM calls/sec (at 10K msg/sec) | ~10,000 | ~2,000–4,000 |
| p95 classification latency | 500–1500ms | < 50ms (cache hit) |
| LLM provider dependency | Hard | Graceful degradation |

---

## Summary

| Concern | Solution |
|---------|----------|
| Burst absorption (10K/sec) | Fast ACK + message queue + virtual threads |
| Cross-platform identity | `user_identity_map` with compound index on provider+ID |
| Document bloat in long chats | Bucket pattern with time/size rollover |
| 5-min context in < 100ms | 1–2 bucket reads via compound index + projection |
| Redundant LLM calls | Semantic cache with embedding similarity search |
| LLM outage resilience | Cache fallback + circuit breaker |
