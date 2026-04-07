const { env } = require("./env");
const { ExtractionOutput } = require("./validators");

function normalizeText(s) {
  return String(s || "").trim();
}

function mockExtraction(text) {
  const t = text.toLowerCase();

  let userSentiment = "Neutral";
  if (/(refund|angry|mad|scam|charged|wrong|hate)/.test(t)) userSentiment = "Negative";
  if (/(refund|angry|charged|scam|wrong)/.test(t)) userSentiment = "Angry";
  if (/(frustrat|stuck|doesn'?t work|won'?t work|can't|cant)/.test(t))
    userSentiment = "Frustrated";
  if (/(thanks|thank you|great|love|awesome|appreciate)/.test(t))
    userSentiment = "Positive";

  let productInterest = "Low";
  if (/(buy|order|price|pricing|plan|subscribe|subscription|checkout)/.test(t))
    productInterest = "High";
  if (/(maybe|consider|thinking|not sure)/.test(t)) productInterest = "Medium";
  if (/(not interested|no thanks|pass)/.test(t)) productInterest = "NotInterested";

  // Confidence is higher when we trigger a clearer keyword.
  const keywordHits = [
    /(refund|angry|charged|scam|wrong)/,
    /(frustrat|stuck|doesn'?t work|won'?t work|can't|cant)/,
    /(thanks|thank you|great|love|awesome|appreciate)/,
    /(buy|order|price|pricing|plan|subscribe|subscription|checkout)/,
    /(maybe|consider|thinking|not sure)/,
    /(not interested|no thanks|pass)/,
  ].reduce((acc, re) => acc + (re.test(t) ? 1 : 0), 0);

  const confidence = Math.max(0.55, Math.min(0.97, 0.55 + keywordHits * 0.09));

  return {
    userSentiment,
    productInterest,
    confidence,
  };
}

function pickKeywordForCorrection(text, override) {
  const t = text.toLowerCase();
  const candidates = [
    { kw: "refund", re: /(refund|charged|wrong)/ },
    { kw: "price", re: /(price|pricing|plan|subscription)/ },
    { kw: "cancel", re: /(cancel|stop|unsubscribe)/ },
    { kw: "buy", re: /(buy|order|checkout)/ },
    { kw: "help", re: /(help|support|issue|problem)/ },
  ];
  const found = candidates.find((c) => c.re.test(t));
  if (found) return found.kw;
  // Fallback: use first 8 chars of text (safe-ish) as a tag.
  return override === "sentiment" ? "sentiment_tag" : "interest_tag";
}

function mockCriticUpdate({ text, aiExtraction, override, promptContext }) {
  const keyword =
    pickKeywordForCorrection(text, "sentiment") ||
    pickKeywordForCorrection(text, "interest");

  const newLine = `- If message mentions "${keyword}", set user_sentiment="${override.userSentiment}" and product_interest="${override.productInterest}".`;

  const versionMatch = String(promptContext.context_version).match(/(\d+)/);
  const baseVersion = versionMatch ? Number(versionMatch[1]) : Number(promptContext.context_version) || 1;
  const newVersion = baseVersion + 1;

  const newText = [
    promptContext.prompt_context_text.trimEnd(),
    `\n\n# Self-correction v${newVersion}`,
    newLine,
  ].join("\n");

  return {
    whatWentWrong:
      aiExtraction.userSentiment !== override.userSentiment ||
      aiExtraction.productInterest !== override.productInterest
        ? "Mock critic: override indicates mismatch between keyword rules and expected labels."
        : "Mock critic: labels already match; kept prompt compatible.",
    updateRuleSummary: `Add rule for keyword "${keyword}".`,
    newPromptContextText: newText,
  };
}

async function extractUserSignals({ text, promptContext }) {
  if (env.MOCK_LLM) {
    const out = mockExtraction(text);
    return ExtractionOutput.parse(out);
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("Real LLM mode requires OPENAI_API_KEY (or set MOCK_LLM=true).");
  }

  const system = promptContext.prompt_context_text;
  const user = [
    "WhatsApp message:",
    normalizeText(text),
    "",
    "Return JSON with keys user_sentiment, product_interest, confidence.",
    "confidence must be between 0 and 1.",
  ].join("\n");

  const content = await callOpenAI({
    model: env.OPENAI_EXTRACT_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const parsed = safeJsonParse(content);
  return ExtractionOutput.parse(parsed);
}

async function criticUpdatePrompt({ text, aiExtraction, override, promptContext }) {
  if (env.MOCK_LLM) {
    return mockCriticUpdate({ text, aiExtraction, override, promptContext });
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("Real LLM mode requires OPENAI_API_KEY (or set MOCK_LLM=true).");
  }

  const system = [
    "You are a critic agent helping update extraction prompt rules.",
    "Given a message, the first-pass AI extraction, and a human override, explain briefly what went wrong",
    "and propose prompt-context text that will improve future extractions.",
    "Output ONLY valid JSON.",
  ].join("\n");

  const user = [
    "Message:",
    normalizeText(text),
    "",
    "First-pass extraction:",
    JSON.stringify(aiExtraction),
    "",
    "Human override:",
    JSON.stringify(override),
    "",
    "Current prompt_context_text:",
    promptContext.prompt_context_text,
  ].join("\n");

  const content = await callOpenAI({
    model: env.OPENAI_CRITIC_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });

  const parsed = safeJsonParse(content);
  if (!parsed.newPromptContextText) {
    throw new Error("Critic response missing newPromptContextText");
  }
  return parsed;
}

module.exports = {
  extractUserSignals,
  criticUpdatePrompt,
};

async function callOpenAI({ model, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");
  return content;
}

function safeJsonParse(s) {
  const raw = String(s || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Try extracting the first JSON object from the text.
    const match = raw.match(/{[\s\S]*}/);
    if (!match) throw new Error("Failed to parse JSON from LLM output");
    return JSON.parse(match[0]);
  }
}

