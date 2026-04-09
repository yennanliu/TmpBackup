# Assignment 2: The Self-Correction Pipeline

## Overview

A live feedback loop where AI extracts **User Sentiment** and **Product Interest** from WhatsApp messages. When a human agent overrides the AI's output, a MongoDB Change Stream triggers a **Critic Agent** that analyzes the error and updates a shared **Prompt Context** to improve future accuracy.

---

## 1. The Code

### System Design

```
                         ┌─────────────────┐
  WhatsApp message ─────▶│  POST /messages  │
                         │  (Ingest API)    │
                         └────────┬─────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼              ▼
              ┌──────────┐ ┌──────────┐   ┌───────────┐
              │ Store    │ │ Load     │   │ Call LLM  │
              │ message  │ │ prompt   │   │ extract:  │
              │          │ │ context  │   │ sentiment │
              │          │ │ (latest) │   │ + interest│
              └──────────┘ └──────────┘   └─────┬─────┘
                                                │
                                                ▼
                                          ┌───────────┐
                                          │ Store     │
                                          │ extraction│
                                          │ result    │
                                          └───────────┘

  Human override ──────▶ POST /messages/:id/override
                              │
                              ▼
                        ┌───────────┐
                        │ Store     │
                        │ override  │──── MongoDB Change Stream
                        └───────────┘            │
                                                 ▼
                                          ┌─────────────┐
                                          │Critic Agent │
                                          │ • why wrong?│
                                          │ • new rules │
                                          │ • update    │
                                          │   prompt    │
                                          │   context   │
                                          └─────────────┘
```

### Collections

**`messages`** — raw inbound messages

```json
{
  "_id": "msg_001",
  "provider": "whatsapp",
  "text": "I'm frustrated, your premium plan is too expensive",
  "created_at": "2026-04-09T10:00:00Z"
}
```

**`extraction_results`** — AI first-pass output

```json
{
  "_id": "ext_001",
  "message_id": "msg_001",
  "user_sentiment": "negative",
  "product_interest": "premium_plan",
  "confidence": 0.78,
  "prompt_context_version": 3,
  "model": "gpt-4o-mini",
  "created_at": "2026-04-09T10:00:01Z"
}
```

**`human_overrides`** — corrections (Change Stream target)

```json
{
  "_id": "ovr_001",
  "message_id": "msg_001",
  "extraction_id": "ext_001",
  "corrected_sentiment": "mixed",
  "corrected_interest": "pricing",
  "overridden_by": "agent_42",
  "critic_applied": false,
  "created_at": "2026-04-09T10:05:00Z"
}
```

**`prompt_context`** — versioned prompt improvements

```json
{
  "_id": "ctx_v4",
  "version": 4,
  "rules": [
    "If user mentions price frustration but asks about features, classify sentiment as 'mixed' not 'negative'",
    "Map 'too expensive' references to product_interest: 'pricing', not the plan name"
  ],
  "few_shot_examples": [
    { "text": "Love the app but the premium plan costs too much", "sentiment": "mixed", "interest": "pricing" }
  ],
  "created_at": "2026-04-09T10:05:30Z"
}
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/messages` | Ingest WhatsApp message → store + extract |
| `GET`  | `/messages/:id` | Get message with extraction result |
| `POST` | `/messages/:id/override` | Human correction → triggers critic |
| `GET`  | `/prompt-context` | View current prompt context version |

### Critic Agent Logic

The critic receives a structured input and outputs structured improvements:

```
Input:
  - original_text: "I'm frustrated, your premium plan is too expensive"
  - ai_output:     { sentiment: "negative", interest: "premium_plan" }
  - human_output:  { sentiment: "mixed", interest: "pricing" }
  - current_rules: [...]

Output:
  - error_analysis: "The AI over-indexed on 'frustrated' without considering
                     the implicit comparison. The user is interested in the
                     product but unhappy with pricing specifically."
  - new_rules:      ["If user mentions price frustration but asks about
                      features, classify sentiment as 'mixed' not 'negative'"]
  - new_examples:   [{ text: "...", sentiment: "mixed", interest: "pricing" }]
```

The worker watches `human_overrides` via Change Stream, filters for `critic_applied: false`, runs the critic, writes a new `prompt_context` version, and sets `critic_applied: true`.

### Tech Stack (Vibe-Coded for Speed)

- **Runtime:** Node.js (or Kotlin + Ktor if preferred)
- **Database:** MongoDB Atlas
- **LLM:** OpenAI API (gpt-4o-mini for extraction, gpt-4o for critic)
- **Structure:** Single repo, two processes — API server + critic worker

---

## 2. The "Push" Factor (Deploy in 24 Hours)

### Hour-by-hour plan

| Time | Action |
|------|--------|
| 0–2h | Scaffold repo, set up MongoDB Atlas Serverless, env vars |
| 2–6h | Implement `/messages` ingestion + LLM extraction |
| 6–8h | Implement `/messages/:id/override` + Change Stream watcher |
| 8–12h | Implement critic agent logic + prompt context versioning |
| 12–14h | Wire end-to-end, test the full loop manually |
| 14–18h | Add error handling, logging, demo scripts |
| 18–22h | Deploy to Railway/Render (single container, two processes) |
| 22–24h | Run demo, write docs, record walkthrough |

### Infra choices for speed

- **MongoDB Atlas Serverless** — no capacity planning, pay-per-op, Change Streams work out of the box.
- **Railway or Render** — deploy from GitHub push, zero DevOps overhead.
- **Single container** — API + critic worker in one process (separate in prod via `ROLE=api|worker` env var).
- **No auth for MVP** — hardcode an API key; add proper auth later.

---

## 3. The Business Logic (Critic Agent Cost Control)

### The core question

> Does the critic save more money than it costs?

### Cost model

```
Critic cost per run:
  ~1,500 input tokens + ~500 output tokens
  ≈ $0.01–0.03 per critic call (gpt-4o)

Value of one fewer future override:
  Human agent time: ~2 min × $0.50/min = $1.00
  Plus: better customer experience from faster, correct routing
```

**One critic call that prevents even a single future override pays for itself 30–100x.**

### Guardrails to keep costs bounded

| Control | Mechanism |
|---------|-----------|
| **Only trigger on real overrides** | No override → no critic. Zero idle cost. |
| **Deduplication** | `critic_applied` flag ensures each override triggers exactly one critic run. |
| **Rate limiting** | Cap critic runs to N/minute. Queue excess for batch processing. |
| **Token budget** | Hard limit on critic prompt size (truncate long conversations). |
| **Sampling at scale** | If overrides exceed 100/day, sample 20% — pattern-level learning, not per-message. |
| **Diminishing returns detection** | Track override rate over time. If rate plateaus, reduce critic frequency. |

### Measuring ROI

Track two metrics:

1. **Override rate** — % of extractions corrected by humans. Should decrease over time as prompt context improves.
2. **Critic cost vs. override savings** — `(cost_per_critic_run × runs) vs. (overrides_prevented × cost_per_override)`.

```
Week 1: 50 overrides/day, 50 critic runs → $1.50/day critic cost
Week 2: 30 overrides/day (40% reduction) → 20 overrides saved × $1.00 = $20/day saved
ROI: ~13x
```

If override rate stops improving after N prompt context versions, pause the critic and rely on the accumulated prompt context. The system is **self-limiting** — fewer human corrections means fewer critic triggers means lower cost.

### The flywheel

```
Better prompt context
        │
        ▼
Fewer AI errors ──▶ Fewer human overrides ──▶ Fewer critic runs
        ▲                                            │
        └────────── Smarter prompt updates ◀─────────┘
```

The critic's cost converges toward zero as the system improves. The value it created — a refined, battle-tested prompt context — persists permanently.
