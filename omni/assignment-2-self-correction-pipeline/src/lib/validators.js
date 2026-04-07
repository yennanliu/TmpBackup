const { z } = require("zod");

const Sentiment = z.enum(["Positive", "Neutral", "Negative", "Angry", "Frustrated"]);
const ProductInterest = z.enum(["High", "Medium", "Low", "NotInterested"]);

const IngestWhatsAppBody = z.object({
  providerMessageId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  text: z.string().min(1).max(5000),
  operatorUserId: z.string().min(1).optional(),
});

const OverrideBody = z.object({
  userSentiment: Sentiment,
  productInterest: ProductInterest,
  overriddenBy: z.string().min(1).optional(),
});

// Output shape from extraction LLM (or mock).
const ExtractionOutput = z.object({
  userSentiment: Sentiment,
  productInterest: ProductInterest,
  confidence: z.number().min(0).max(1),
});

module.exports = {
  Sentiment,
  ProductInterest,
  IngestWhatsAppBody,
  OverrideBody,
  ExtractionOutput,
};

