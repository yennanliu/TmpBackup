const { startServer } = require("./server");
const { startCriticWorker } = require("./worker");

async function main() {
  const serverStarted = await startServer();
  startCriticWorker().catch((e) => {
    console.error("Critic worker crashed:", e);
    process.exit(1);
  });

  return serverStarted;
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});

