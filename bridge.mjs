#!/usr/bin/env node
// ZCode Bridge v2 — real OpenAI-compatible model provider.
// Translates OpenAI chat/completions (incl. tools & streaming) directly to the
// Z.ai zcode-plan Anthropic endpoint, using the official client's identity
// (ZCode JWT + device-mid + version headers) so Hermes's own agent loop —
// tools, skills, memory — works untouched.
import { createServer } from "node:http";
import { createHash, createDecipheriv, randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = dirname(fileURLToPath(import.meta.url));
const PORT = 20145;
const PLAN_ORIGIN = process.env.BRIDGE_DEBUG_RELAY ? "http://127.0.0.1:20991" : "https://zcode.z.ai";
const PLAN_ANTHROPIC = `${PLAN_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`;
const DEVICE_MID = (() => {
  try {
    return JSON.parse(readFileSync(join(process.env.HOME ?? "", ".zcode", "v2", "telemetry-state.json"), "utf8")).deviceMid;
  } catch { return randomUUID(); }
})();

const ACCOUNTS_DIR = join(BASE, "accounts");
// The official ZCode agent system prompt — the zcode-plan endpoint's WAF
// only accepts requests carrying it (see cli-request-capture notes).
const ZCODE_SYSTEM = JSON.parse(readFileSync(join(BASE, "zcode-system.json"), "utf8"));
const rr = { i: 0 };
const IDENTITY_ENV = {
  ZCODE_APP_VERSION: "3.18.2",
  ZCODE_CLIENT_LANGUAGE: "en-US",
};

function listAccounts() {
  if (!existsSync(ACCOUNTS_DIR)) return [];
  return readdirSync(ACCOUNTS_DIR).filter(name => {
    const dir = join(ACCOUNTS_DIR, name);
    return existsSync(join(dir, ".credential-secret")) && existsSync(join(dir, ".zcode", "v2", "credentials.json"));
  });
}

function openSealed(secret, v) {
  const parts = String(v).split(":");
  if (parts[0] !== "enc" || parts[1] !== "v2" || !["os", "env"].includes(parts[2])) {
    throw new Error("unsupported credential envelope");
  }
  const [iv, tag, ct] = parts[4].split(".").map(s => Buffer.from(s, "base64url"));
  const key = createHash("sha256").update(secret).digest();
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function loadAccount(name) {
  const dir = join(ACCOUNTS_DIR, name);
  const secret = readFileSync(join(dir, ".credential-secret"), "utf8").trim();
  const creds = JSON.parse(readFileSync(join(dir, ".zcode", "v2", "credentials.json"), "utf8"));
  const jwt = openSealed(secret, creds["zcodejwttoken"]);
  const identityKey = "account-provider:account:zai-start-plan:identity";
  const userId = creds[identityKey] ? openSealed(secret, creds[identityKey]) : "unknown-user";
  return { name, jwt, userId };
}

function nextAccount(exclude) {
  const accs = listAccounts().filter(a => a !== exclude);
  const pool = accs.length ? accs : listAccounts();
  if (!pool.length) throw new Error("no bridge accounts — run add-account.sh first");
  const a = pool[rr.i % pool.length];
  rr.i += 1;
  return loadAccount(a);
}

function identityHeaders(jwt, _body, userId) {
  const rid = randomUUID();
  return {
    "http-referer": PLAN_ORIGIN,
    "user-agent": `ZCode/${IDENTITY_ENV.ZCODE_APP_VERSION}`,
    "x-zcode-app-version": IDENTITY_ENV.ZCODE_APP_VERSION,
    "x-title": "Z Code@cli",
    "x-release-channel": "production",
    "x-client-language": IDENTITY_ENV.ZCODE_CLIENT_LANGUAGE,
    "x-client-timezone": "Europe/Berlin",
    "x-zcode-agent": "glm",
    "x-platform": "darwin-arm64",
    "x-os-category": "macos",
    "x-os-version": "25.5.0",
    "x-request-id": rid,
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": randomUUID(),
    "x-query-id": `query_${rid}`,
    "x-zcode-query-source": "main_turn",
    "x-session-id": `sess_${randomUUID()}`,
    "authorization": `Bearer ${jwt}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

// ── OpenAI → Anthropic translation ──────────────────────────────────────────
function toAnthropic(body, userId) {
  const system = [];
  const messages = [];
  let lastToolResults = [];
  const flushToolResults = () => {
    if (lastToolResults.length) {
      messages.push({ role: "user", content: lastToolResults });
      lastToolResults = [];
    }
  };
  for (const m of body.messages ?? []) {
    const role = m.role;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.map(p => (typeof p === "string" ? p : p.text ?? "")).join("\n").trim();
    }
    if (role === "system" || role === "developer") {
      if (text) system.push(text);
      continue;
    }
    if (role === "tool") {
      lastToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "unknown",
        content: text || "(empty)",
      });
      continue;
    }
    flushToolResults();
    if (role === "assistant") {
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch {}
        blocks.push({ type: "tool_use", id: tc.id ?? `call_${randomUUID()}`, name: tc.function?.name, input });
      }
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    messages.push({ role: role === "assistant" ? "assistant" : "user", content: [{ type: "text", text: text || "…" }] });
  }
  flushToolResults();

  const tools = (body.tools ?? [])
    .filter(t => t?.type === "function" && t.function)
    .map(t => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));

  const maxTokens = Math.min(Math.max(body.max_tokens ?? body.max_completion_tokens ?? 64000, 256), 128000);
  const out = {
    model: "GLM-5.3-Flash",
    max_tokens: maxTokens,
    stream: Boolean(body.stream),
    messages,
    metadata: { user_id: userId },
    thinking: { type: "enabled" },
    output_config: { effort: "low" },
  };
  // WAF requires the system prompt to be EXACTLY the official agent prompt
  // (extra/missing blocks are rejected). The caller's system text is injected
  // into the first user message instead, so the model still honors it.
  out.system = ZCODE_SYSTEM;
  if (system.length) {
    const sysText = "[System instructions]\n" + system.join("\n\n");
    if (messages.length && messages[0].role === "user" && Array.isArray(messages[0].content)) {
      messages[0].content.unshift({ type: "text", text: sysText + "\n\n---\n" });
    } else {
      messages.unshift({ role: "user", content: [{ type: "text", text: sysText }] });
    }
  }
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = { type: "auto" };
  }
  return out;
}

// ── Anthropic → OpenAI translation ──────────────────────────────────────────
function anthropicToOpenAISse(anthropicSseBody, { model, cid }) {
  const chunks = [];
  const created = Math.floor(Date.now() / 1000);
  const chunk = delta => JSON.stringify({
    id: cid, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  const lines = anthropicSseBody.split("\n");
  const toolCalls = new Map(); // index → {id, name, args}
  let textBuf = "";
  let finish = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    let ev;
    try { ev = JSON.parse(dataStr); } catch { continue; }
    const type = ev.type ?? ev.event;
    if (type === "content_block_start") {
      const b = ev.content_block;
      if (b?.type === "tool_use") {
        toolCalls.set(ev.index, { id: b.id, name: b.name, args: "" });
        chunks.push(chunk({ tool_calls: [{ index: ev.index, type: "function",
          id: b.id, function: { name: b.name, arguments: "" } }] }));
      }
    } else if (type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta") {
        textBuf += d.text ?? "";
        chunks.push(chunk({ role: "assistant", content: d.text ?? "" }));
      } else if (d?.type === "input_json_delta") {
        const tc = toolCalls.get(ev.index);
        if (tc) {
          tc.args += d.partial_json ?? "";
          chunks.push(chunk({ tool_calls: [{ index: ev.index, function: { arguments: d.partial_json ?? "" } }] }));
        }
      }
    } else if (type === "message_delta") {
      const reason = ev.delta?.stop_reason;
      if (reason === "tool_use") finish = "tool_calls";
      else if (reason) finish = "stop";
      const usage = ev.usage;
      if (usage && chunks.length) {
        // usage rides on the final chunk below
      }
    } else if (type === "error") {
      chunks.push(JSON.stringify({ error: { message: ev.error?.message ?? "upstream error" } }));
    }
  }
  const finalDelta = {};
  chunks.push(JSON.stringify({
    id: cid, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finish ?? "stop" }],
  }));
  chunks.push("[DONE]");
  return { textBuf, sse: chunks.map(c => `data: ${c}\n\n`).join("") };
}

function anthropicToOpenAIJson(anthropicJson, { model, cid }) {
  let text = "";
  const toolCalls = [];
  for (const b of anthropicJson.content ?? []) {
    if (b.type === "text") text += b.text ?? "";
    else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  const msg = { role: "assistant", content: text || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const u = anthropicJson.usage ?? {};
  return {
    id: cid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, finish_reason: toolCalls.length ? "tool_calls" : "stop", message: msg }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
  };
}

async function callUpstream(openaiBody) {
  let lastErr;
  for (let attempt = 0; attempt < Math.max(1, listAccounts().length); attempt++) {
    const account = nextAccount(lastErr?.account);
    const anthropicBody = toAnthropic(openaiBody, account.userId);
    const res = await fetch(PLAN_ANTHROPIC, {
      method: "POST",
      headers: identityHeaders(account.jwt, anthropicBody, account.userId),
      body: JSON.stringify(anthropicBody),
    });
    if (res.status === 401 || res.status === 403) {
      lastErr = new Error(`account ${account.name}: HTTP ${res.status} (login expired? run add-account.sh ${account.name})`);
      lastErr.account = account.name;
      continue;
    }
    return { res, account };
  }
  throw lastErr ?? new Error("no accounts available");
}

function handler(req, res) {
  const urlPath = (req.url ?? "").split("?")[0].replace(/\/+$/, "");
  if (req.method === "GET") {
    if (urlPath === "/health" || urlPath === "/v1/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, accounts: listAccounts() }));
    }
    if (urlPath === "/v1/models" || urlPath === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [
        { id: "glm-5.3-flash", object: "model", owned_by: "zcode-bridge" },
      ] }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "not found" } }));
  }
  if (req.method !== "POST" || !urlPath.endsWith("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "not found" } }));
  }

  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", async () => {
    let body;
    try { body = JSON.parse(raw || "{}"); } catch {
      console.log(`[bridge] bad json len=${raw.length} head=${raw.slice(0,80)}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "bad json" } }));
    }
    const model = "glm-5.3-flash";
    const cid = `zbridge-${Date.now()}`;
    let upstream;
    try {
      upstream = await callUpstream(body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: String(e.message ?? e).slice(0, 500) } }));
    }
    const { res: ures, account } = upstream;
    if (!ures.ok) {
      const errText = await ures.text().catch(() => "");
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `upstream HTTP ${ures.status}: ${errText.slice(0, 400)}` } }));
    }
    if (!body.stream) {
      const j = await ures.json().catch(() => null);
      if (!j) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "bad upstream json" } }));
      }
      console.log(`[bridge] ${account.name} json ok`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(anthropicToOpenAIJson(j, { model, cid })));
    }
    // streaming: translate Anthropic SSE → OpenAI SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "close",
    });
    const respText = await ures.text();
    const { sse } = anthropicToOpenAISse(respText, { model, cid });
    console.log(`[bridge] ${account.name} stream ok (${respText.length}b)`);
    res.end(sse);
  });
}

createServer(handler).listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] zcode-bridge v2 (model proxy) on http://127.0.0.1:${PORT} accounts=${listAccounts().join(",")}`);
});
