const { MongoClient } = require("mongodb");
const { env, assertEnv } = require("./env");
const crypto = require("crypto");

let clientPromise = null;

function now() {
  return new Date();
}

function randomId() {
  return crypto.randomUUID();
}

async function connectMongo() {
  assertEnv();
  if (!clientPromise) {
    clientPromise = new MongoClient(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    }).connect();
  }
  return clientPromise;
}

async function getDb() {
  const client = await connectMongo();
  return client.db(env.MONGODB_DB || "assignment2");
}

async function ensureIndexes(db) {
  const whatsapp = db.collection("whatsapp_messages");
  const extraction = db.collection("extraction_results");
  const overrides = db.collection("human_overrides");
  const promptContext = db.collection("prompt_context");

  await whatsapp.createIndex({ created_at: -1 });
  await extraction.createIndex({ message_id: 1 }, { unique: true }).catch(() => {});
  await overrides.createIndex({ message_id: 1 });
  await overrides.createIndex({ created_at: -1 });
  await promptContext.createIndex({ _id: 1 }, { unique: true });
}

async function ensurePromptContext(db) {
  const promptContext = db.collection("prompt_context");
  await promptContext.updateOne(
    { _id: "prompt_context" },
    {
      $setOnInsert: {
        _id: "prompt_context",
        context_version: 1,
        prompt_context_text:
          [
            "You are an extraction classifier for WhatsApp messages.",
            "Extract:",
            "- user_sentiment: one of Positive | Neutral | Negative | Angry | Frustrated",
            "- product_interest: one of High | Medium | Low | NotInterested",
            "Return only valid JSON matching the required schema.",
          ].join("\n"),
        created_at: now(),
        updated_at: now(),
      },
    },
    { upsert: true }
  );
}

async function getPromptContext(db) {
  const promptContext = db.collection("prompt_context");
  const doc = await promptContext.findOne({ _id: "prompt_context" });
  if (!doc) throw new Error("prompt_context document missing");
  return doc;
}

async function insertMessageAndExtraction({
  db,
  messageId,
  providerMessageId,
  conversationId,
  operatorUserId,
  text,
  extraction,
}) {
  const whatsapp = db.collection("whatsapp_messages");
  const extractionResults = db.collection("extraction_results");

  const messageDoc = {
    _id: messageId,
    provider: "whatsapp",
    provider_message_id: providerMessageId || null,
    conversation_id: conversationId || null,
    operator_user_id: operatorUserId || null,
    text,
    created_at: now(),
  };

  const extractionDoc = {
    _id: messageId,
    message_id: messageId,
    ai_version: `mock`,
    user_sentiment: extraction.userSentiment,
    product_interest: extraction.productInterest,
    confidence: extraction.confidence,
    created_at: now(),
  };

  await whatsapp.insertOne(messageDoc);
  await extractionResults.insertOne(extractionDoc);
}

async function insertHumanOverride({
  db,
  overrideId,
  messageId,
  extractionResultId,
  overriddenUserSentiment,
  overriddenProductInterest,
  overriddenBy,
}) {
  const overrides = db.collection("human_overrides");
  const doc = {
    _id: overrideId,
    message_id: messageId,
    extraction_result_id: extractionResultId,
    overridden_user_sentiment: overriddenUserSentiment,
    overridden_product_interest: overriddenProductInterest,
    overrode_by: overriddenBy || "human",
    critic_applied: false,
    critic_started_at: null,
    critic_applied_at: null,
    critic_output_summary: null,
    critic_prompt_context_version_used: null,
    created_at: now(),
  };
  await overrides.insertOne(doc);
}

async function claimOverrideJob({ db, overrideId, promptContextVersion }) {
  const overrides = db.collection("human_overrides");

  // "Claim" is atomic: only one worker can flip critic_started_at from null.
  const res = await overrides.findOneAndUpdate(
    { _id: overrideId, critic_applied: false, critic_started_at: null },
    {
      $set: {
        critic_started_at: now(),
        critic_prompt_context_version_used: promptContextVersion,
      },
    },
    { returnDocument: "after" }
  );
  return res.value || null;
}

async function markOverrideCriticApplied({
  db,
  overrideId,
  criticOutputSummary,
  newPromptContextVersion,
}) {
  const overrides = db.collection("human_overrides");
  await overrides.updateOne(
    { _id: overrideId },
    {
      $set: {
        critic_applied: true,
        critic_applied_at: now(),
        critic_output_summary: criticOutputSummary,
        critic_prompt_context_version_used: newPromptContextVersion,
      },
    }
  );
}

async function updatePromptContext({ db, newText }) {
  const promptContext = db.collection("prompt_context");

  const res = await promptContext.findOneAndUpdate(
    { _id: "prompt_context" },
    {
      $inc: { context_version: 1 },
      $set: {
        prompt_context_text: newText,
        updated_at: now(),
      },
    },
    { returnDocument: "after" }
  );

  if (!res.value) throw new Error("prompt_context update failed");
  return res.value.context_version;
}

module.exports = {
  randomId,
  connectMongo,
  getDb,
  ensureIndexes,
  ensurePromptContext,
  getPromptContext,
  insertMessageAndExtraction,
  insertHumanOverride,
  claimOverrideJob,
  markOverrideCriticApplied,
  updatePromptContext,
};

