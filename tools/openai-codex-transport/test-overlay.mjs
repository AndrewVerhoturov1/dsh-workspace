import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "openai-codex-transport-overlay-"));
const backup = join(root, "backup");
const dshRoot = join(root, "dsh");
const files = {
  dshPackage: join(dshRoot, "package.json"),
  piPackage: join(dshRoot, "node_modules", "@earendil-works", "pi-ai", "package.json"),
  adapterPackage: join(dshRoot, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "package.json"),
  diagnostics: join(dshRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "diagnostics.js"),
  codex: join(dshRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js"),
  adapter: join(dshRoot, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
};

try {
  await Promise.all(Object.values(files).map((path) => mkdir(join(path, ".."), { recursive: true })));
  await writeFile(files.dshPackage, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.1-rc.2" }));
  await writeFile(files.piPackage, JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.82.1" }));
  await writeFile(files.adapterPackage, JSON.stringify({ name: "@deepseek-ai/dsh-llm-pi-ai", version: "0.1.1-rc.2" }));
  await writeFile(files.diagnostics, `export function formatThrownValue(value) { return String(value); }\nexport function extractDiagnosticError(error) {\n    if (!(error instanceof Error))\n        return { name: "ThrownValue", message: formatThrownValue(error) };\n    const code = error.code;\n    return {\n        name: error.name || undefined,\n        message: error.message || error.name,\n        stack: error.stack,\n        code: typeof code === "string" || typeof code === "number" ? code : undefined,\n    };\n}\n`);
  await writeFile(files.codex, `const websocketSseFallbackSessions = new Set();\nfunction getOrCreateWebSocketDebugStats(sessionId) { return {}; }\nfunction recordWebSocketFailure(sessionId, error) {\n    if (!sessionId)\n        return;\n    websocketSseFallbackSessions.add(sessionId);\n    const stats = getOrCreateWebSocketDebugStats(sessionId);\n    stats.websocketFailures++;\n    stats.lastWebSocketError = formatThrownValue(error);\n    stats.websocketFallbackActive = true;\n}\n`);
  await writeFile(files.adapter, `function mapStopReason(message, contextWindow) {\n    const text = message.errorMessage ?? "pi-ai stream error";\n    return {\n        kind: "error",\n        failure: {\n            message: text,\n            code: classifyPiAiError(text)\n        }\n    };\n}\n`);

  const script = fileURLToPath(new URL("./apply-overlay.mjs", import.meta.url));
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`overlay exit ${code}: ${stderr || stdout}`)));
  });
  await run(["--apply", "--root", dshRoot, "--backup-dir", backup]);
  const verified = await run(["--verify", "--root", dshRoot]);
  if (!verified.stdout.includes('"status": "APPLIED"')) throw new Error("overlay verify did not report APPLIED");
  const patchedCodex = await readFile(files.codex, "utf8");
  const patchedDiagnostics = await readFile(files.diagnostics, "utf8");
  const patchedAdapter = await readFile(files.adapter, "utf8");
  if (!patchedCodex.includes("OPENAI_CODEX_TRANSPORT_REQUEST_SCOPED_FALLBACK_V1")) throw new Error("request-scoped fallback marker is missing");
  if (patchedCodex.includes("websocketSseFallbackSessions.add(sessionId)")) throw new Error("fallback is still sticky");
  if (!patchedDiagnostics.includes("OPENAI_CODEX_TRANSPORT_DIAGNOSTIC_V1")) throw new Error("diagnostic marker is missing");
  if (!patchedAdapter.includes("...mapProviderDiagnostics(message)")) throw new Error("adapter does not forward diagnostics");
  await run(["--rollback", "--manifest", join(backup, "manifest.json")]);
  const restored = await readFile(files.codex, "utf8");
  if (!restored.includes("websocketSseFallbackSessions.add(sessionId)")) throw new Error("rollback did not restore original codex file");
  console.log("overlay test: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
