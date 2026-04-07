const { env, assertEnv } = require("./lib/env");
const {
  getDb,
  ensureIndexes,
  ensurePromptContext,
  getPromptContext,
  claimOverrideJob,
  markOverrideCriticApplied,
  updatePromptContext,
} = require("./lib/mongo");
const { criticUpdatePrompt } = require("./lib/llm");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processOverride({ db, overrideDoc }) {
  const overrideId = overrideDoc._id;

  // Fetch current prompt context (used both in claim and critic).
  const promptContext = await getPromptContext(db);
  const promptContextVersion = promptContext.context_version;

  // Atomic claim: only one worker should run critic per override.
  const claimed = await claimOverrideJob({ db, overrideId, promptContextVersion });
  if (!claimed) return;

  try {
    const messages = db.collection("whatsapp_messages");
    const extractionResults = db.collection("extraction_results");

    const messageDoc = await messages.findOne({ _id: overrideDoc.message_id });
    const extractionDoc = await extractionResults.findOne({ _id: overrideDoc.extraction_result_id });

    if (!messageDoc || !extractionDoc) {
      await markOverrideCriticApplied({
        db,
        overrideId,
        criticOutputSummary: `Critic skipped: missing message/extraction (message=${!!messageDoc}, extraction=${!!extractionDoc}).`,
        newPromptContextVersion: promptContextVersion,
      });
      return;
    }

    const aiExtraction = {
      userSentiment: extractionDoc.user_sentiment,
      productInterest: extractionDoc.product_interest,
      confidence: extractionDoc.confidence,
    };

    // Run critic to update prompt_context.
    const critic = await criticUpdatePrompt({
      text: messageDoc.text,
      aiExtraction,
      override: {
        userSentiment: overrideDoc.overridden_user_sentiment,
        productInterest: overrideDoc.overridden_product_interest,
      },
      promptContext,
    });

    const newContextText = critic.newPromptContextText;
    const newVersion = await updatePromptContext({ db, newText: newContextText });

    const summary = `${critic.whatWentWrong} ${critic.updateRuleSummary}`.trim();

    await markOverrideCriticApplied({
      db,
      overrideId,
      criticOutputSummary: summary,
      newPromptContextVersion: newVersion,
    });
  } catch (e) {
    console.error("Critic failed for override", overrideId, e);
    await markOverrideCriticApplied({
      db,
      overrideId,
      criticOutputSummary: `Critic error: ${e && e.message ? e.message : String(e)}`,
      newPromptContextVersion: promptContextVersion,
    });
  }
}

async function startCriticWorker() {
  assertEnv();
  const db = await getDb();
  await ensureIndexes(db);
  await ensurePromptContext(db);

  const overridesColl = db.collection("human_overrides");

  // Change streams are the "ideal" trigger; if unsupported, we fall back to polling.
  let usingChangeStreams = false;

  async function pollLoop() {
    console.log("Critic worker running in polling mode.");
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const toProcess = await overridesColl
        .find({
          critic_applied: false,
          critic_started_at: null,
        })
        .limit(10)
        .toArray();

      for (const overrideDoc of toProcess) {
        // eslint-disable-next-line no-await-in-loop
        await processOverride({ db, overrideDoc });
      }

      await sleep(2000);
    }
  }

  async function changeStreamLoop() {
    usingChangeStreams = true;
    console.log("Critic worker running with Mongo change streams.");

    // Watch inserts; inserts set critic_applied=false and critic_started_at=null.
    const pipeline = [{ $match: { operationType: "insert" } }];
    const stream = overridesColl.watch(pipeline, { fullDocument: "updateLookup" });

    // eslint-disable-next-line no-restricted-syntax
    for await (const change of stream) {
      const doc = change.fullDocument;
      if (!doc) continue;
      if (doc.critic_applied) continue;
      if (doc.critic_started_at) continue;

      // eslint-disable-next-line no-await-in-loop
      await processOverride({ db, overrideDoc: doc });
    }
  }

  try {
    await changeStreamLoop();
  } catch (e) {
    console.warn(
      "Change streams unavailable; switching to polling mode. Error:",
      e && e.message ? e.message : String(e)
    );
    if (!usingChangeStreams) {
      await pollLoop();
    }
  }
}

module.exports = { startCriticWorker };

if (require.main === module) {
  startCriticWorker().catch((e) => {
    console.error("Worker failed to start:", e);
    process.exit(1);
  });
}

