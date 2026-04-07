const express = require("express");

const { env, assertEnv } = require("./lib/env");
const {
  IngestWhatsAppBody,
  OverrideBody,
  ExtractionOutput,
} = require("./lib/validators");
const {
  getDb,
  ensureIndexes,
  ensurePromptContext,
  getPromptContext,
  randomId,
  insertMessageAndExtraction,
  insertHumanOverride,
} = require("./lib/mongo");
const { extractUserSignals } = require("./lib/llm");

function sendError(res, status, message, details) {
  res.status(status).json({ error: message, details });
}

async function startServer() {
  assertEnv();
  const db = await getDb();
  await ensureIndexes(db);
  await ensurePromptContext(db);

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

  app.post("/messages/whatsapp", async (req, res) => {
    const parsed = IngestWhatsAppBody.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body", parsed.error.issues);
    }

    try {
      const promptContext = await getPromptContext(db);
      const messageId = randomId();

      const extraction = await extractUserSignals({
        text: parsed.data.text,
        promptContext,
      });

      // Extra sanity check (esp. in real mode).
      const validatedExtraction = ExtractionOutput.parse(extraction);

      await insertMessageAndExtraction({
        db,
        messageId,
        providerMessageId: parsed.data.providerMessageId,
        conversationId: parsed.data.conversationId,
        operatorUserId: parsed.data.operatorUserId,
        text: parsed.data.text,
        extraction: {
          userSentiment: validatedExtraction.userSentiment,
          productInterest: validatedExtraction.productInterest,
          confidence: validatedExtraction.confidence,
        },
      });

      return res.status(201).json({
        messageId,
        extraction: validatedExtraction,
        promptContextVersion: promptContext.context_version,
        criticApplied: false,
      });
    } catch (e) {
      console.error("POST /messages/whatsapp failed:", e);
      return sendError(res, 500, "Server error");
    }
  });

  app.post("/messages/:messageId/override", async (req, res) => {
    const messageId = req.params.messageId;
    if (!messageId) return sendError(res, 400, "Missing messageId");

    const parsed = OverrideBody.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body", parsed.error.issues);
    }

    try {
      const overrideId = randomId();
      const extractionResultId = messageId; // we used messageId as extraction_result_id

      await insertHumanOverride({
        db,
        overrideId,
        messageId,
        extractionResultId,
        overriddenUserSentiment: parsed.data.userSentiment,
        overriddenProductInterest: parsed.data.productInterest,
        overriddenBy: parsed.data.overriddenBy || "human",
      });

      return res.status(201).json({
        overrideId,
        messageId,
        criticApplied: false,
      });
    } catch (e) {
      console.error("POST /messages/:messageId/override failed:", e);
      return sendError(res, 500, "Server error");
    }
  });

  app.get("/prompt-context", async (_req, res) => {
    try {
      const promptContext = await getPromptContext(db);
      return res.status(200).json({
        contextVersion: promptContext.context_version,
        promptContextText: promptContext.prompt_context_text,
      });
    } catch (e) {
      console.error("GET /prompt-context failed:", e);
      return sendError(res, 500, "Server error");
    }
  });

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on :${env.PORT}`);
  });

  return { app, server, db };
}

module.exports = { startServer };

if (require.main === module) {
  startServer().catch((e) => {
    console.error("Server failed to start:", e);
    process.exit(1);
  });
}

