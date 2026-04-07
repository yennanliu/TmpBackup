const dotenv = require("dotenv");

dotenv.config();

function parseBool(v, defaultValue) {
  if (v === undefined) return defaultValue;
  return String(v).toLowerCase() === "true";
}

const env = {
  PORT: Number(process.env.PORT || 3000),
  MONGODB_URI: process.env.MONGODB_URI || "",
  MONGODB_DB: process.env.MONGODB_DB || "",
  MOCK_LLM: parseBool(process.env.MOCK_LLM, true),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_EXTRACT_MODEL: process.env.OPENAI_EXTRACT_MODEL || "gpt-4o-mini",
  OPENAI_CRITIC_MODEL: process.env.OPENAI_CRITIC_MODEL || "gpt-4o-mini",
};

if (!env.MONGODB_URI) {
  // Keep the module importable for syntax checks; fail fast on actual start.
  // (Worker/server call `assertEnv()` when starting.)
  env._missingMongo = true;
}

function assertEnv() {
  if (env._missingMongo) {
    throw new Error(
      "Missing required env var `MONGODB_URI`. Create `.env` or set it before starting."
    );
  }
}

module.exports = { env, assertEnv };

