#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = Object.freeze({
  dsh: "0.1.1-rc.2",
  piAi: "0.82.1",
  adapter: "0.1.1-rc.2",
});

const FILES = Object.freeze({
  diagnostics: ["node_modules", "@earendil-works", "pi-ai", "dist", "utils", "diagnostics.js"],
  codex: ["node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js"],
  adapter: ["node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"],
});

const MARKERS = Object.freeze({
  diagnostics: "OPENAI_CODEX_TRANSPORT_DIAGNOSTIC_V1",
  codex: "OPENAI_CODEX_TRANSPORT_REQUEST_SCOPED_FALLBACK_V1",
  adapter: "OPENAI_CODEX_TRANSPORT_DIAGNOSTIC_FORWARD_V1",
});

function usage() {
  console.error("Usage: node -X utf8 apply-overlay.mjs --verify|--apply|--rollback --root <dsh-root> [--backup-dir <dir>] [--manifest <file>]");
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function defaultRoot() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "npm", "node_modules", "@deepseek-ai", "dsh");
}

function filePath(root, parts) {
  return join(root, ...parts);
}

async function packageVersions(root) {
  const dsh = await readJson(join(root, "package.json"));
  const piAi = await readJson(join(root, "node_modules", "@earendil-works", "pi-ai", "package.json"));
  const adapter = await readJson(join(root, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "package.json"));
  return { dsh: dsh.version, piAi: piAi.version, adapter: adapter.version };
}

function assertVersions(versions) {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    if (versions[name] !== expected) {
      throw new Error(`unsupported ${name} version: expected ${expected}, got ${versions[name] ?? "missing"}`);
    }
  }
}

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  return source.replace(needle, replacement);
}

function patchDiagnostics(source) {
  if (source.includes(MARKERS.diagnostics)) return source;
  if (source.includes("export function extractErrorFacts(value") && source.includes("extractErrorFacts(error.cause)")) {
    return source.replace("const MAX_DIAGNOSTIC_CAUSE_DEPTH = 2;", `// ${MARKERS.diagnostics}\nconst MAX_DIAGNOSTIC_CAUSE_DEPTH = 2;`);
  }
  const old = `export function extractDiagnosticError(error) {
    if (!(error instanceof Error))
        return { name: "ThrownValue", message: formatThrownValue(error) };
    const code = error.code;
    return {
        name: error.name || undefined,
        message: error.message || error.name,
        stack: error.stack,
        code: typeof code === "string" || typeof code === "number" ? code : undefined,
    };
}`;
  const next = `// ${MARKERS.diagnostics}
const MAX_DIAGNOSTIC_CAUSE_DEPTH = 2;
export function extractErrorFacts(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value) || depth > MAX_DIAGNOSTIC_CAUSE_DEPTH)
        return undefined;
    seen.add(value);
    const result = {};
    for (const key of ["name", "message", "code", "errno", "syscall", "address", "port"]) {
        const field = value[key];
        if (typeof field === "string" || typeof field === "number")
            result[key] = field;
    }
    const cause = extractErrorFacts(value.cause, depth + 1, seen);
    if (cause)
        result.cause = cause;
    return Object.keys(result).length ? result : undefined;
}
export function extractDiagnosticError(error) {
    if (!(error instanceof Error))
        return { name: "ThrownValue", message: formatThrownValue(error) };
    const facts = extractErrorFacts(error) ?? { name: error.name || "Error", message: error.message || error.name };
    return { ...facts, stack: error.stack };
}`;
  return replaceOnce(source, old, next, "diagnostics helper");
}

function patchCodex(source) {
  if (source.includes(MARKERS.codex)) return source;
  const old = `function recordWebSocketFailure(sessionId, error) {
    if (!sessionId)
        return;
    websocketSseFallbackSessions.add(sessionId);
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    stats.websocketFailures++;
    stats.lastWebSocketError = formatThrownValue(error);
    stats.websocketFallbackActive = true;
}`;
  const next = `function recordWebSocketFailure(sessionId, error) {
    if (!sessionId)
        return;
    // ${MARKERS.codex}: a transient WebSocket failure may use SSE for this request,
    // but must not pin the whole session to SSE.
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    stats.websocketFailures++;
    stats.lastWebSocketError = formatThrownValue(error);
    stats.websocketFallbackActive = false;
}`;
  return replaceOnce(source, old, next, "request-scoped fallback");
}

function patchAdapter(source) {
  if (source.includes(MARKERS.adapter)) return source;
  const old = `function mapStopReason(message, contextWindow) {`;
  const helper = `// ${MARKERS.adapter}
function mapProviderDiagnostics(message) {
    const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
    return diagnostics.length > 0 ? { diagnostics: diagnostics.slice(-8) } : {};
}
function mapStopReason(message, contextWindow) {`;
  let next = replaceOnce(source, old, helper, "diagnostic forwarding helper");
  const match = next.match(/([ \t]+code: classifyPiAiError\(text\))(\r?\n[ \t]+})/);
  if (!match) throw new Error("diagnostic forwarding: expected one match, got 0");
  const closeIndent = match[2].match(/[ \t]+(?=})/)?.[0] ?? "";
  const codeIndent = match[1].slice(0, -"code: classifyPiAiError(text)".length);
  const replacement = `${codeIndent}code: classifyPiAiError(text),\n${codeIndent}...mapProviderDiagnostics(message)\n${closeIndent}}`;
  next = replaceOnce(next, match[0], replacement, "diagnostic forwarding");
  return next;
}

async function transformedFiles(root) {
  const paths = Object.fromEntries(Object.entries(FILES).map(([key, parts]) => [key, filePath(root, parts)]));
  const source = {};
  for (const [key, path] of Object.entries(paths)) source[key] = await readFile(path, "utf8");
  return {
    paths,
    source,
    next: {
      diagnostics: patchDiagnostics(source.diagnostics),
      codex: patchCodex(source.codex),
      adapter: patchAdapter(source.adapter),
    },
  };
}

async function verify(root) {
  const versions = await packageVersions(root);
  assertVersions(versions);
  const files = await transformedFiles(root);
  const markers = Object.fromEntries(Object.entries(MARKERS).map(([key, marker]) => [key, files.source[key].includes(marker)]));
  const result = { root, versions, markers, status: Object.values(markers).every(Boolean) ? "APPLIED" : "NOT_APPLIED" };
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "APPLIED") process.exitCode = 1;
}

async function apply(root, backupDir) {
  if (!backupDir) throw new Error("--backup-dir is required for --apply");
  const versions = await packageVersions(root);
  assertVersions(versions);
  const files = await transformedFiles(root);
  const changed = Object.entries(files.next).filter(([key, value]) => value !== files.source[key]);
  if (changed.length === 0) {
    await verify(root);
    return;
  }
  await mkdir(backupDir, { recursive: true });
  const manifest = { schema: 1, root, versions, files: [] };
  for (const [key, value] of changed) {
    const path = files.paths[key];
    const backup = join(backupDir, `${key}.js`);
    const original = Buffer.from(files.source[key], "utf8");
    await writeFile(backup, original);
    await writeFile(path, value, "utf8");
    manifest.files.push({ key, path, backup, originalSha256: sha256(original), patchedSha256: sha256(Buffer.from(value, "utf8")) });
  }
  const manifestPath = join(backupDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: "APPLIED", manifest: manifestPath, changed: changed.map(([key]) => key) }, null, 2));
}

async function rollback(manifestPath) {
  if (!manifestPath) throw new Error("--manifest is required for --rollback");
  const manifest = await readJson(manifestPath);
  for (const entry of manifest.files ?? []) {
    if (!existsSync(entry.path)) throw new Error(`rollback target is missing: ${entry.path}`);
    const current = await readFile(entry.path);
    if (sha256(current) !== entry.patchedSha256) throw new Error(`rollback target changed after overlay: ${entry.path}`);
  }
  for (const entry of manifest.files) await copyFile(entry.backup, entry.path);
  console.log(JSON.stringify({ status: "ROLLED_BACK", manifest: manifestPath, files: manifest.files.map((entry) => entry.path) }, null, 2));
}

async function main() {
  const root = resolve(arg("--root") ?? defaultRoot());
  if (process.argv.includes("--verify")) return verify(root);
  if (process.argv.includes("--apply")) {
    const backupDir = arg("--backup-dir");
    return apply(root, backupDir ? resolve(backupDir) : undefined);
  }
  if (process.argv.includes("--rollback")) {
    const manifest = arg("--manifest");
    return rollback(manifest ? resolve(manifest) : undefined);
  }
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
