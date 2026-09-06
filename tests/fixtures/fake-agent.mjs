const promptIndex = process.argv.findIndex((value) => value === "-p" || value === "--prompt" || value === "--print");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] || "" : process.argv.slice(2).join(" ");
const sessionId = process.env.FAKE_AGENT_SESSION || "fake-session-001";
const delayMs = Number(process.env.FAKE_AGENT_DELAY_MS || 0);

let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
  process.exit(143);
});

process.stdout.write(`${JSON.stringify({ type: "system", session_id: sessionId })}\n`);
setTimeout(() => {
  if (stopped) return;
  process.stdout.write(`${JSON.stringify({ type: "assistant", text: `Recommendation: complete the request for ${prompt}` })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "assistant", text: "Risks: verify the result on the target repository" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "assistant", text: "Next steps: run the focused checks" })}\n`);
  process.exit(0);
}, delayMs);
