# Assignment 2: Self-Correction Pipeline (Vibe Coding & Startup Execution)

This repo is a minimal, runnable implementation of the “self-correction pipeline”:

- AI extracts `user_sentiment` + `product_interest` from an inbound WhatsApp message
- A human override is stored in MongoDB
- MongoDB Change Streams (or polling fallback) triggers a “Critic Agent”
- The critic updates a shared `prompt_context` document to improve future extractions

## Run

```bash
cd omni/assignment-2-self-correction-pipeline
npm install
cp .env.example .env
```

Set at least:
- `MONGODB_URI`

Then:

```bash
npm start
```

The service starts the API and the critic worker in the same process.

## API

### 1) Ingest message

```bash
curl -sS -X POST "http://localhost:3000/messages/whatsapp" \
  -H "Content-Type: application/json" \
  -d '{
    "providerMessageId":"wa_1",
    "conversationId":"conv_1",
    "text":"I want a refund, you charged me wrong"
  }'
```

Response includes `messageId` and the first-pass extraction.

### 2) Human override

```bash
curl -sS -X POST "http://localhost:3000/messages/<messageId>/override" \
  -H "Content-Type: application/json" \
  -d '{
    "userSentiment":"Angry",
    "productInterest":"Low",
    "overriddenBy":"human_operator_123"
  }'
```

### 3) Inspect prompt context

```bash
curl -sS "http://localhost:3000/prompt-context"
```

After the critic runs, `contextVersion` and `promptContextText` will update.

## Notes about grading

1. `MOCK_LLM=true` is the default so the end-to-end loop works without external API keys.
2. Set `MOCK_LLM=false` and provide `OPENAI_API_KEY` to use a real LLM.
3. Mongo Change Streams require a MongoDB topology that supports them (e.g., Atlas). If unavailable, the worker falls back to polling.

