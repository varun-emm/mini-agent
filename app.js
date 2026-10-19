/* Mini Agent: an agent loop (think -> act -> observe -> check) running in your browser on Groq or OpenRouter.
   Everything here is the "harness". The model only writes text; this file runs the tools. */
"use strict";

// ---------------------------------------------------------------------------
// Providers: where the "brain" lives. Both speak the same OpenAI-style API.
// ---------------------------------------------------------------------------
const PROVIDERS = {
  groq: {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyPrefix: "gsk_",
    keyLink: "https://console.groq.com/keys",
    defaultModel: "openai/gpt-oss-120b",
    searchModel: "groq/compound-mini",          // Groq model with built-in web search
    visionModel: "qwen/qwen3.8-27b",             // looks at screenshots
    visionModels: [["qwen/qwen3.8-27b", "Reads images, up to 3 per request"]],
    models: [["openai/gpt-oss-120b", "Smartest"], ["openai/gpt-oss-20b", "Fastest"], ["qwen/qwen3.8-27b", "Preview"]],
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    keyPrefix: "sk-or-",
    keyLink: "https://openrouter.ai/settings/keys",
    defaultModel: "openai/gpt-oss-120b",
    searchModel: "openai/gpt-oss-120b",         // cheap model + OpenRouter's "web" plugin
    visionModel: "anthropic/claude-haiku-5.5",
    visionModels: [["anthropic/claude-haiku-5.5", "Sharp at reading documents"], ["openai/gpt-6-luna", "Fast and cheap"], ["qwen/qwen3.8-omni-flash", "Cheap alternative"]],
    models: [["openai/gpt-oss-120b", "Cheap and capable"], ["anthropic/claude-sonnet-5.5", "Smarter, costs more"]],
  },
};
const MAX_STEPS = 20;
const MAX_TOOL_OUTPUT = 6000;
const MAX_HISTORY_CHARS = 60000;

// ---------------------------------------------------------------------------
// Settings & chat storage (localStorage, this browser only)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } },
};

function loadSettings() {
  const saved = store.get("ma.settings", {}) || {};
  const s = {
    provider: "groq",
    keys: { groq: "", openrouter: "" },
    models: { groq: PROVIDERS.groq.defaultModel, openrouter: PROVIDERS.openrouter.defaultModel },
    visionModels: { groq: PROVIDERS.groq.visionModel, openrouter: PROVIDERS.openrouter.visionModel },
    askBeforeCode: false,
    relayUrl: "",
  };
  if (typeof saved.apiKey === "string") s.keys.groq = saved.apiKey;            // first version
  if (typeof saved.model === "string" && saved.model) s.models.groq = saved.model;
  if (PROVIDERS[saved.provider]) s.provider = saved.provider;
  Object.assign(s.keys, saved.keys || {});
  Object.assign(s.models, saved.models || {});
  Object.assign(s.visionModels, saved.visionModels || {});
  if (typeof saved.askBeforeCode === "boolean") s.askBeforeCode = saved.askBeforeCode;
  if (typeof saved.relayUrl === "string") s.relayUrl = saved.relayUrl;
  if (!s.keys[s.provider]) {
    const withKey = Object.keys(PROVIDERS).find((p) => s.keys[p]);
    if (withKey) s.provider = withKey;
  }
  return s;
}

function detectProvider(key) {
  if (key.startsWith(PROVIDERS.openrouter.keyPrefix)) return "openrouter";
  if (key.startsWith(PROVIDERS.groq.keyPrefix)) return "groq";
  return null;
}

const state = {
  settings: loadSettings(),
  chat: null,          // the conversation that's open (null = a fresh, unsaved one)
  history: [],         // what the model sees (without the system prompt)
  log: [],             // what the chat shows
  running: false,
  abort: null,
};

const provider = () => PROVIDERS[state.settings.provider];
const apiKey = () => state.settings.keys[state.settings.provider] || "";
const currentModel = () => state.settings.models[state.settings.provider] || provider().defaultModel;
const visionModel = () => state.settings.visionModels[state.settings.provider] || provider().visionModel;

// ---------------------------------------------------------------------------
// IndexedDB: chats and file bytes live here, on this device only
// ---------------------------------------------------------------------------
const db = {
  handle: null,
  async open() {
    try {
      this.handle = await new Promise((resolve, reject) => {
        const req = indexedDB.open("mini-agent", 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "path" });
          if (!d.objectStoreNames.contains("chats")) d.createObjectStore("chats", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      this.handle.onversionchange = () => this.handle.close();
    } catch (_) { this.handle = null; /* private mode etc: keep things in memory for this visit */ }
  },
  all(name) {
    if (!this.handle) return Promise.resolve([]);
    return new Promise((resolve) => {
      try {
        const req = this.handle.transaction(name).objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  },
  put(name, value) { if (this.handle) try { this.handle.transaction(name, "readwrite").objectStore(name).put(value); } catch (_) { /* ignore */ } },
  del(name, key) { if (this.handle) try { this.handle.transaction(name, "readwrite").objectStore(name).delete(key); } catch (_) { /* ignore */ } },
};

// ---------------------------------------------------------------------------
// Files: raw bytes, so Excel/Word/PDF/images survive intact. Each chat has its own files.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

const files = {
  all: new Map(),   // "chatId/path" -> { chat, path, bytes: Uint8Array, mtime }
  scope: null,      // the open chat's id
  k(path, chat = this.scope) { return `${chat}/${path}`; },
  put(path, bytes, mtime = Date.now()) {
    if (!this.scope) return;
    const key = this.k(path);
    this.all.set(key, { chat: this.scope, path, bytes, mtime });
    db.put("files", { path: key, chat: this.scope, name: path, bytes: bytes.slice().buffer, mtime });
  },
  remove(path) { const key = this.k(path); this.all.delete(key); db.del("files", key); },
  get(path) { return this.all.get(this.k(path)); },
  has(path) { return this.all.has(this.k(path)); },
  paths(chat = this.scope) { return [...this.all.values()].filter((r) => r.chat === chat).map((r) => r.path).sort(); },
  snapshot() { return new Map(this.paths().map((p) => [p, this.get(p).mtime])); },
  removeChat(chat) { for (const [key, r] of this.all) if (r.chat === chat) { this.all.delete(key); db.del("files", key); } },
};

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------
function titleFrom(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim() || "New chat";
  if (t.length > 48) t = t.slice(0, 47).replace(/\s\S*$/, "") + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const chats = {
  list: new Map(),
  create(firstText) {
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    const chat = { id, title: titleFrom(firstText), created: now, updated: now, history: [], log: [] };
    this.list.set(id, chat);
    return chat;
  },
  save(chat, touch = true) {
    if (touch) chat.updated = Date.now();
    if (db.handle) db.put("chats", chat);
    else store.set("ma.chats", [...this.list.values()]);   // fallback when IndexedDB isn't available
  },
  remove(id) {
    this.list.delete(id);
    files.removeChat(id);
    if (db.handle) db.del("chats", id); else store.set("ma.chats", [...this.list.values()]);
  },
  sorted() { return [...this.list.values()].sort((a, b) => b.updated - a.updated); },
};

const save = {
  settings: () => store.set("ma.settings", state.settings),
  chat: () => {
    if (!state.chat) return;
    state.chat.history = state.history;
    state.chat.log = state.log;
    chats.save(state.chat);
  },
};

// Load chats and files, and bring data from older versions (one chat, files without a chat) along.
async function loadStorage() {
  await db.open();
  const [chatRows, fileRows] = await Promise.all([db.all("chats"), db.all("files")]);
  for (const c of db.handle ? chatRows : store.get("ma.chats", [])) if (c && c.id) chats.list.set(c.id, c);

  let legacy = null;
  const oldLog = store.get("ma.log", null);
  if (Array.isArray(oldLog) && oldLog.length) {
    const firstUser = oldLog.find((e) => e.kind === "user");
    legacy = chats.create(firstUser ? firstUser.text : "Earlier chat");
    legacy.log = oldLog;
    legacy.history = store.get("ma.history", []) || [];
    chats.save(legacy);
  }
  const owner = () => legacy || (legacy = chats.create("Earlier files"));
  for (const r of fileRows) {
    if (r.chat) { files.all.set(r.path, { chat: r.chat, path: r.name, bytes: new Uint8Array(r.bytes), mtime: r.mtime }); continue; }
    const c = owner();                                   // a file saved before chats existed
    files.scope = c.id; files.put(r.path, new Uint8Array(r.bytes), r.mtime); db.del("files", r.path);
  }
  const oldText = store.get("ma.files", null);
  if (oldText && typeof oldText === "object") {
    const c = owner(); files.scope = c.id;
    for (const [p, text] of Object.entries(oldText)) if (!files.has(p)) files.put(p, enc.encode(String(text)));
  }
  if (legacy) { chats.save(legacy, false); store.set("ma.currentChat", legacy.id); }
  store.remove("ma.log"); store.remove("ma.history"); store.remove("ma.files");
  files.scope = null;
  const current = chats.list.get(store.get("ma.currentChat", ""));
  return current || null;
}

const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const EXT_INFO = {
  xlsx: ["sheet", "Excel spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  xls: ["sheet", "Excel spreadsheet", "application/vnd.ms-excel"],
  csv: ["sheet", "CSV", "text/csv"],
  tsv: ["sheet", "TSV", "text/tab-separated-values"],
  docx: ["doc", "Word document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  pdf: ["pdf", "PDF", "application/pdf"],
  pptx: ["slides", "PowerPoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  png: ["image", "PNG image", "image/png"],
  jpg: ["image", "JPEG image", "image/jpeg"],
  jpeg: ["image", "JPEG image", "image/jpeg"],
  gif: ["image", "GIF image", "image/gif"],
  webp: ["image", "WebP image", "image/webp"],
  svg: ["image", "SVG image", "image/svg+xml"],
  md: ["text", "Markdown", "text/markdown"],
  txt: ["text", "Text", "text/plain"],
  html: ["code", "HTML", "text/html"],
  htm: ["code", "HTML", "text/html"],
  json: ["code", "JSON", "application/json"],
  py: ["code", "Python", "text/x-python"],
  js: ["code", "JavaScript", "text/javascript"],
  css: ["code", "CSS", "text/css"],
  xml: ["code", "XML", "application/xml"],
  zip: ["archive", "ZIP archive", "application/zip"],
};
function fileInfo(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const [kind, label, mime] = EXT_INFO[ext] || ["file", ext ? ext.toUpperCase() + " file" : "File", "application/octet-stream"];
  return { ext, kind, label, mime };
}
const isTextual = (path) => ["text", "code"].includes(fileInfo(path).kind) || ["csv", "tsv"].includes(fileInfo(path).ext);
function humanSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const blobUrls = new Map();
function fileUrl(path) {
  const f = files.get(path);
  if (!f) return null;
  const key = files.k(path);
  const cached = blobUrls.get(key);
  if (cached && cached.mtime === f.mtime) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(new Blob([f.bytes], { type: fileInfo(path).mime }));
  blobUrls.set(key, { url, mtime: f.mtime });
  return url;
}

// ---------------------------------------------------------------------------
// Talking to the model
// ---------------------------------------------------------------------------
class AgentError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function endpoint() {
  if (state.settings.provider === "openrouter") return PROVIDERS.openrouter.url;
  if (state.settings.relayUrl) return state.settings.relayUrl.trim();
  if (location.hostname.endsWith(".vercel.app")) return "/api/chat";
  return PROVIDERS.groq.url;
}

async function postLLM(body, signal) {
  try {
    return await fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    if (state.settings.provider === "openrouter") {
      throw new AgentError("Couldn't reach OpenRouter. Check your internet connection and try again.", "network");
    }
    throw new AgentError("Couldn't reach Groq. You may be offline, or Groq may be blocking calls from web pages. " +
      "Switching to an OpenRouter key in Settings fixes the second case.", "network");
  }
}

// Turn an error from either provider into a plain-English AgentError.
function apiError(status, err, model) {
  const name = provider().name;
  const e = err || {};
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "tool_use_failed" || /tool_use_failed/.test(e.message || "")) return new AgentError(e.message || "Malformed tool call", "tool_use_failed");
  if (status === 401) return new AgentError(`${name} rejected the API key. Check it in Settings.`, "auth");
  if (status === 402) return new AgentError(`Your ${name} account is out of credits. Top up, or pick a cheaper model in Settings.`, "credits");
  if (status === 429) {
    const when = (((e.message || "").match(/try again in\s*([\dhms.]+)/i) || [])[1] || "").replace(/\.+$/, "");
    return new AgentError(`${name}'s rate limit was hit${when ? ` (it says to try again in ${when})` : ""}. Wait, then tap Try again. ` +
      (name === "Groq" ? "Groq's free tier allows only a few requests per minute; an OpenRouter key avoids this." : ""), "rate");
  }
  if (status === 404 && /model/i.test(e.message || "")) {
    return new AgentError(`${name} doesn't recognise the model "${model}", or it can't use tools. Pick another model in Settings.`, "model");
  }
  return new AgentError(`${name} returned an error (${status}): ${e.message || "unknown error"}`, code || "http");
}

// Rate limits: wait as long as the provider asks (up to ~45s, a few times), then try again by itself.
let rateNotice = null;   // set while a turn runs, so the status line can say what's happening
const waitFor = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Stopped", "AbortError")); }, { once: true });
});
async function postWithRetry(body, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await postLLM(body, signal);
    if (res.status !== 429 || attempt >= 3) return res;
    let text = "";
    try { text = await res.clone().text(); } catch (_) { /* ignore */ }
    let wait = Number(res.headers.get("retry-after")) || 0;
    const m = text.match(/try again in\s*(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)\b/i);
    if (m) wait = Number(m[1] || 0) * 60 + (m[3].toLowerCase() === "ms" ? Number(m[2]) / 1000 : Number(m[2]));
    if (!wait) wait = 5 * (attempt + 1);
    if (wait > 45) return res;                       // a long wait (daily limit): report it instead
    wait = Math.ceil(wait + 0.5);
    if (rateNotice) rateNotice(wait, attempt + 1);
    await waitFor(wait * 1000, signal);
  }
}

async function callLLM(body, signal) {
  const res = await postWithRetry(body, signal);
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  const err = (data && data.error) || null;
  if (!res.ok || err) throw apiError(res.ok ? Number(err && err.code) || 500 : res.status, err, body.model);
  if (!data || !Array.isArray(data.choices) || !data.choices[0]) {
    throw new AgentError(`${provider().name} sent back an empty reply. Try again.`, "empty");
  }
  return data;
}

// Streaming version: reports thinking, answer text and tool calls as they are written.
// on = { reasoning(chunk, all), content(chunk, all), tool(call, index), first() }
async function streamLLM(body, signal, on = {}) {
  const res = await postWithRetry({ ...body, stream: true }, signal);
  const msg = { content: "", reasoning: "", tool_calls: [] };
  const fire = (name, ...a) => { try { on[name] && on[name](...a); } catch (_) { /* UI errors never break the loop */ } };
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.includes("application/json")) {   // errors, or a relay that doesn't stream
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    const err = (data && data.error) || null;
    if (!res.ok || err) throw apiError(res.ok ? Number(err && err.code) || 500 : res.status, err, body.model);
    const m = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!m) throw new AgentError(`${provider().name} sent back an empty reply. Try again.`, "empty");
    fire("first");
    if (m.reasoning) { msg.reasoning = m.reasoning; fire("reasoning", m.reasoning, msg.reasoning); }
    (m.tool_calls || []).forEach((tc, i) => { msg.tool_calls[i] = tc; fire("tool", tc, i); });
    if (m.content) { msg.content = m.content; fire("content", m.content, msg.content); }
    return msg;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let done = false;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;          // blank lines and ": keep-alive" comments
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(payload); } catch (_) { return; }
    if (chunk.error) throw apiError(Number(chunk.error.code) || 500, chunk.error, body.model);
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.error) throw apiError(500, choice.error, body.model);
    const d = choice.delta || {};
    if (!started) { started = true; fire("first"); }
    let think = typeof d.reasoning === "string" ? d.reasoning : typeof d.reasoning_content === "string" ? d.reasoning_content : "";
    if (!think && Array.isArray(d.reasoning_details)) {
      think = d.reasoning_details.map((r) => r.text || r.summary || "").join("");
    }
    if (think) { msg.reasoning += think; fire("reasoning", think, msg.reasoning); }
    if (typeof d.content === "string" && d.content) { msg.content += d.content; fire("content", d.content, msg.content); }
    for (const tc of d.tool_calls || []) {
      const i = typeof tc.index === "number" ? tc.index : msg.tool_calls.length;
      const slot = msg.tool_calls[i] || (msg.tool_calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      const fn = tc.function || {};
      if (fn.name && fn.name !== slot.function.name) slot.function.name = slot.function.name ? slot.function.name + fn.name : fn.name;
      if (typeof fn.arguments === "string") slot.function.arguments += fn.arguments;
      fire("tool", slot, i);
    }
  };
  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      handle(line);
      if (done) break;
    }
  }
  if (buffer.trim()) handle(buffer.trim());
  try { reader.cancel(); } catch (_) { /* already closed */ }
  msg.tool_calls = msg.tool_calls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_${Date.now()}_${i}` }));
  if (!started) throw new AgentError(`${provider().name} sent back an empty reply. Try again.`, "empty");
  return msg;
}

// ---------------------------------------------------------------------------
// TOOLS: the agent's hands
// ---------------------------------------------------------------------------
const truncate = (t, n = MAX_TOOL_OUTPUT) => {
  t = String(t);
  return t.length <= n ? t : t.slice(0, n) + `\n...[truncated, ${t.length - n} more chars]`;
};

function cleanPath(p) {
  const parts = String(p || "").replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.includes("..")) throw new Error("Use a simple file name, like notes/report.md");
  return parts.join("/");
}

async function askWeb(prompt, signal, domain) {
  const body = { model: provider().searchModel, messages: [{ role: "user", content: prompt }] };
  if (state.settings.provider === "openrouter") {
    const plugin = { id: "web", max_results: 5 };
    if (domain) plugin.include_domains = [domain];
    body.plugins = [plugin];
  }
  const data = await callLLM(body, signal);
  const msg = data.choices[0].message;
  let text = msg.content || "";
  const urls = new Set();
  for (const t of msg.executed_tools || []) {
    for (const r of (t.search_results && t.search_results.results) || []) if (r.url) urls.add(r.url);
  }
  for (const a of msg.annotations || []) {
    if (a.type === "url_citation" && a.url_citation && a.url_citation.url) urls.add(a.url_citation.url);
  }
  if (urls.size) text += "\n\nSources:\n" + [...urls].slice(0, 8).map((u) => "- " + u).join("\n");
  return text || "No results.";
}

function calculate(expression) {
  let s = String(expression).replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^");
  if (!/[a-z]/i.test(s)) s = s.replace(/,/g, "");
  const compact = s.replace(/\s+/g, "");
  const tokens = compact.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z_][a-z0-9_]*|[()+\-*/%^,]/gi) || [];
  if (tokens.join("") !== compact) throw new Error("Only numbers, + - * / % ^, brackets and maths functions are allowed.");
  const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, log: Math.log, log10: Math.log10,
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  };
  const CONSTS = { pi: Math.PI, e: Math.E };
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expr = () => {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = next(); const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const term = () => {
    let v = unary();
    while (["*", "/", "%"].includes(peek())) {
      const op = next(); const r = unary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const unary = () => {
    if (peek() === "-") { next(); return -unary(); }
    if (peek() === "+") { next(); return unary(); }
    return power();
  };
  const power = () => {
    const base = primary();
    if (peek() === "^") { next(); return base ** unary(); }
    return base;
  };
  const primary = () => {
    const t = next();
    if (t === undefined) throw new Error("The expression ended too early.");
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t === "(") { const v = expr(); if (next() !== ")") throw new Error("Missing a closing bracket."); return v; }
    const name = t.toLowerCase();
    if (name in CONSTS) return CONSTS[name];
    if (name in FUNCS) {
      if (next() !== "(") throw new Error(`${name} needs brackets, like ${name}(2)`);
      const args = [];
      if (peek() !== ")") { args.push(expr()); while (peek() === ",") { next(); args.push(expr()); } }
      if (next() !== ")") throw new Error("Missing a closing bracket.");
      return FUNCS[name](...args);
    }
    throw new Error(`I don't know "${t}".`);
  };
  const value = expr();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i]}".`);
  if (!Number.isFinite(value)) throw new Error("The result isn't a finite number.");
  return String(Number(value.toPrecision(15)));
}

// Python runs in a Web Worker with Pyodide (downloaded once, then cached by the browser).
const python = {
  worker: null, seq: 0, pending: new Map(), warmed: false,
  start() {
    this.worker = new Worker("py-worker.js?v=20261019d");
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      if (e.data.progress) { p.onProgress && p.onProgress(e.data.progress); return; }
      this.pending.delete(e.data.id);
      p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.resolve({ ok: false, error: e.message || "Python crashed" });
      this.pending.clear();
      this.worker = null;
    };
  },
  kill() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.warmed = false;
    for (const p of this.pending.values()) p.resolve({ ok: false, error: "Stopped." });
    this.pending.clear();
  },
  run(code, timeoutMs, onProgress) {
    if (!this.worker) this.start();
    const id = ++this.seq;
    const payload = {};
    for (const p of files.paths()) payload[p] = files.get(p).bytes;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        resolve({ ok: false, error: `Stopped after ${Math.round(timeoutMs / 1000)} seconds (too slow, or stuck in a loop).` });
      }, timeoutMs);
      this.pending.set(id, { onProgress, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      this.worker.postMessage({ id, code, files: payload });
    });
  },
};

function approveCode(code) {
  if (!state.settings.askBeforeCode) return Promise.resolve(true);
  const dlg = document.getElementById("approve");
  document.getElementById("approveCode").textContent = code;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// Bring the worker's copy of the workspace back, and report what changed.
function syncFromPython(returned) {
  const changed = [];
  for (const [path, bytes] of Object.entries(returned || {})) {
    const cur = files.get(path);
    if (!cur || !sameBytes(cur.bytes, bytes)) { files.put(path, bytes); changed.push(path); }
  }
  const removed = files.paths().filter((p) => !(p in (returned || {})));
  for (const p of removed) files.remove(p);
  return { changed, removed };
}

// ---------------------------------------------------------------------------
// Screenshots: how the agent checks its work with its own eyes.
//   web pages  -> Microlink's free screenshot service (about 25 a day without a key)
//   images     -> used as they are
//   PDFs       -> page rendered with pdf.js
//   Word, Excel, CSV, Markdown, HTML, text -> laid out as a page and captured with html-to-image,
//                 inside a sandboxed frame so nothing in the file can reach this app or your keys
// The picture is then shown to a vision model, which answers the agent's question about it.
// ---------------------------------------------------------------------------
const HTML2IMG_URL = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js";
// the "legacy" build of pdf.js brings its own polyfills, so it also works on older iPhones and browsers
const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.worker.min.mjs";
const SHOT_MAX_W = 1100;
const SHOT_MAX_H = 2400;

async function drawable(blob) {
  try { return await createImageBitmap(blob); } catch (_) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    return img;
  }
}
// Scale to at most SHOT_MAX_W wide (and cap very tall pages), on white, as a JPEG data URL.
async function toJpeg(source) {
  const img = source instanceof Blob ? await drawable(source) : source;
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  const scale = Math.min(1, SHOT_MAX_W / w0);
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.min(SHOT_MAX_H, Math.round(h0 * scale)));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w0 * scale, h0 * scale);
  return { src: c.toDataURL("image/jpeg", 0.86), width: w, height: h, cropped: Math.round(h0 * scale) > SHOT_MAX_H };
}

const escapeHTML = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function pageHTML(inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{background:#fff;color:#111}
    body{margin:0;padding:24px 28px;font:17px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:inline-block;min-width:calc(100% - 56px)}
    table{border-collapse:collapse} td,th{border:1px solid #bdbdbd;padding:6px 10px;font-size:16px;text-align:left;vertical-align:top}
    pre{white-space:pre-wrap;font:15px/1.45 ui-monospace,Menlo,Consolas,monospace}
    img{max-width:100%} .note{color:#555;font-size:14px;margin:0 0 12px}
  </style></head><body>${inner}</body></html>`;
}

// Lay out HTML in a hidden sandboxed frame and photograph it.
function renderHtmlShot(html, width = 1000, fit = false) {
  return new Promise((resolve, reject) => {
    const id = "shot" + Math.random().toString(36).slice(2);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // kept inside the viewport (invisible, behind everything): browsers pause rendering in off-screen frames
    frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1`;
    const capture = `<script src="${HTML2IMG_URL}"><\/script><script>
      window.addEventListener("load", () => setTimeout(async () => {
        try {
          const root = document.documentElement;
          const content = document.body ? Math.ceil(document.body.getBoundingClientRect().height) : 0;
          const h = Math.min(${SHOT_MAX_H}, ${fit} ? Math.max(content, 120) : Math.max(content, root.scrollHeight, 200));
          const url = await htmlToImage.toJpeg(root, { quality: 0.88, backgroundColor: "#ffffff", width: ${width}, height: h, pixelRatio: 1, skipFonts: true });
          parent.postMessage({ shot: "${id}", url, w: ${width}, h }, "*");
        } catch (e) { parent.postMessage({ shot: "${id}", error: String((e && e.message) || e) }, "*"); }
      }, 450));
    <\/script>`;
    const doc = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, capture + "</body>") : html + capture;
    let timer = 0;
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", onMsg); frame.remove(); };
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data || e.data.shot !== id) return;
      cleanup();
      if (e.data.error) reject(new Error(`couldn't render it (${e.data.error})`));
      else resolve({ src: e.data.url, width: e.data.w, height: e.data.h });
    };
    timer = setTimeout(() => { cleanup(); reject(new Error("it took too long to render")); }, 25000);
    window.addEventListener("message", onMsg);
    frame.srcdoc = doc;
    document.body.append(frame);
  });
}

async function pdfShot(bytes, pageNo) {
  const pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const n = Math.min(Math.max(1, Number(pageNo) || 1), doc.numPages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, SHOT_MAX_W / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    return { ...(await toJpeg(canvas)), note: `page ${n} of ${doc.numPages}` };
  } finally { try { await task.destroy(); } catch (_) { /* already closed */ } }
}

// openpyxl writes formulas without calculated values (Excel works them out on opening),
// so show the formula itself instead of an empty cell.
function fillFormulas(ws) {
  let n = 0;
  for (const [addr, cell] of Object.entries(ws || {})) {
    if (addr[0] === "!" || !cell || !cell.f) continue;
    if (cell.v === undefined || cell.v === null || cell.v === "") { cell.t = "s"; cell.v = "=" + cell.f; delete cell.w; n++; }
  }
  return n;
}

async function fileShot(path, pageNo) {
  const f = files.get(path);
  const info = fileInfo(path);
  if (info.kind === "image") return toJpeg(new Blob([f.bytes], { type: info.mime }));
  if (info.ext === "pdf") return pdfShot(f.bytes, pageNo);
  if (info.ext === "pptx") throw new Error("PowerPoint files can't be screenshotted here. Open it with python-pptx and print each slide's text and shapes to check it instead.");
  if (info.ext === "html" || info.ext === "htm") return renderHtmlShot(dec.decode(f.bytes));
  let inner;
  let note = "";
  if (info.ext === "docx") {
    await loadScript(MAMMOTH_URL);
    inner = (await mammoth.convertToHtml({ arrayBuffer: f.bytes.slice().buffer })).value;
  } else if (info.ext === "xlsx" || info.ext === "xls") {
    await loadScript(XLSX_URL);
    const wb = XLSX.read(f.bytes, { type: "array" });
    const idx = Math.min(Math.max(1, Number(pageNo) || 1), wb.SheetNames.length) - 1;
    const name = wb.SheetNames[idx];
    const formulas = fillFormulas(wb.Sheets[name]);
    note = `sheet "${name}"` + (wb.SheetNames.length > 1 ? ` (${idx + 1} of ${wb.SheetNames.length}: ${wb.SheetNames.join(", ")})` : "") +
      (formulas ? `; ${formulas} formula cells show their formulas, because Excel calculates them when the file is opened` : "");
    inner = `<p class="note">${escapeHTML(note)}</p>` + XLSX.utils.sheet_to_html(wb.Sheets[name]);
  } else if (info.ext === "csv" || info.ext === "tsv") {
    const rows = parseCSV(dec.decode(f.bytes), info.ext === "tsv" ? "\t" : ",");
    inner = "<table>" + rows.map((r, i) => "<tr>" + r.map((c) => `<${i ? "td" : "th"}>${escapeHTML(c)}</${i ? "td" : "th"}>`).join("") + "</tr>").join("") + "</table>";
  } else if (info.ext === "md") {
    inner = mdHTML(dec.decode(f.bytes));
  } else if (isTextual(path)) {
    inner = `<pre>${escapeHTML(dec.decode(f.bytes).slice(0, 20000))}</pre>`;
  } else {
    throw new Error(`${info.label} files can't be screenshotted.`);
  }
  return { ...(await renderHtmlShot(pageHTML(inner), 820, true)), note };
}

async function webShot(url) {
  const api = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;
  let res;
  try { res = await fetch(api); } catch (_) { res = null; }
  if (res && res.status === 429) throw new Error("the free screenshot service's daily limit (about 25 screenshots) is used up. Try again tomorrow.");
  if (res && res.ok) {
    const blob = await res.blob();
    if (blob.type.startsWith("image/")) return toJpeg(blob);
  }
  // the service didn't allow reading the image from this page: let the vision model fetch it directly
  return { src: api, width: 0, height: 0, remote: true };
}

// Ask the vision model about a screenshot.
async function lookAt(shot, question, label, signal) {
  const ask = `You are the eyes of an AI agent that is checking its own work. This is a screenshot of ${label}.

What to check: ${question || "Describe what is shown and point out anything that looks wrong."}

Answer precisely and concisely. Quote the exact text and numbers you can read. List any problems you see: text cut off or overlapping, unreadable labels, missing or empty parts, wrong or inconsistent values, bad layout. If you can't make something out, say so rather than guessing.`;
  const data = await callLLM({
    model: visionModel(),
    messages: [{ role: "user", content: [{ type: "text", text: ask }, { type: "image_url", image_url: { url: shot.src } }] }],
    temperature: 0.2,
    max_tokens: 1500,
  }, signal);
  const m = data.choices[0].message || {};
  const text = String(m.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return text || String(m.reasoning || "").trim().slice(-1500) || "(The vision model didn't return an answer.)";
}

const TOOL_FUNCTIONS = {
  async web_search({ query }, ctx) {
    if (!query) throw new Error("query is required");
    return askWeb(`Search the web and answer concisely and factually. Include specific numbers and dates, and list the source URLs you used.\n\nQuery: ${query}`, ctx.signal);
  },
  async fetch_webpage({ url }, ctx) {
    let host = "";
    try { host = new URL(url).hostname; } catch (_) { /* invalid */ }
    if (!/^https?:\/\//i.test(url || "") || !host) throw new Error("Give a full URL starting with http:// or https://");
    return askWeb(`Visit this exact page and report its main content in detail: key facts, numbers, names and dates. Don't add anything that isn't on the page.\n\nURL: ${url}`, ctx.signal, host);
  },
  async calculator({ expression }) { return calculate(expression); },
  async run_python({ code }, ctx) {
    if (!code) throw new Error("code is required");
    if (!(await approveCode(code))) return "The user declined to run this code. Ask them, or try another approach.";
    const r = await python.run(code, python.warmed ? 90000 : 240000, ctx.onProgress);
    if (!r.ok) return "Error: " + r.error;
    python.warmed = true;
    const { changed, removed } = syncFromPython(r.files);
    let out = `exit code: ${r.exit}\nstdout:\n${r.out}\nstderr:\n${r.err}`;
    if (changed.length) out += `\nFiles created or updated (shown to the user automatically): ${changed.map((p) => `${p} (${humanSize(files.get(p).bytes.length)})`).join(", ")}`;
    if (removed.length) out += `\nFiles deleted: ${removed.join(", ")}`;
    return out;
  },
  async write_file({ path, content }) {
    const p = cleanPath(path);
    files.put(p, enc.encode(String(content ?? "")));
    return `Wrote ${humanSize(files.get(p).bytes.length)} to ${p}. It is shown to the user automatically.`;
  },
  async read_file({ path }) {
    const p = cleanPath(path);
    const f = files.get(p);
    if (!f) throw new Error(`No file called ${p}. Use list_files to see what exists.`);
    if (!isTextual(p)) return `${p} is a ${fileInfo(p).label} (${humanSize(f.bytes.length)}). Use run_python to open and inspect it.`;
    return dec.decode(f.bytes);
  },
  async list_files() {
    const names = files.paths();
    return names.length ? names.map((n) => `${n} (${humanSize(files.get(n).bytes.length)})`).join("\n") : "(no files yet)";
  },
  async screenshot({ target, question, page }, ctx) {
    const t = String(target || "").trim();
    if (!t) throw new Error("target is required: the name of a file you made, or a web page URL");
    let shot, label;
    if (/^https?:\/\//i.test(t)) {
      shot = await webShot(t);
      label = `the web page ${t}`;
    } else {
      const p = cleanPath(t);
      if (!files.has(p)) throw new Error(`No file called ${p}. Use list_files to see what exists.`);
      try { shot = await fileShot(p, page); } catch (e) { throw new Error(`Couldn't screenshot ${p}: ${e.message}`); }
      label = `the file ${p}` + (shot.note ? ` (${shot.note})` : "");
    }
    if (ctx.onImage) ctx.onImage(shot.src);
    if (ctx.onProgress) ctx.onProgress(`Looking closely at ${t.length > 50 ? hostOf(t) : t}`);
    const seen = await lookAt(shot, question, label, ctx.signal);
    const size = shot.width ? `${shot.width}×${shot.height}px${shot.cropped ? ", cut off at the bottom because the page is very long" : ""}` : "full page";
    return `Screenshot of ${label} (${size}).\nWhat the vision model (${visionModel()}) saw:\n${seen}`;
  },
  async get_current_time() {
    return new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" }) +
      ` (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  },
};

const tool = (name, description, properties = {}, required = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

const TOOLS = [
  tool("web_search", "Search the web. Use for anything current, factual, or that you are unsure about.",
    { query: { type: "string" } }, ["query"]),
  tool("fetch_webpage", "Read a specific web page by URL. Use after web_search when you need the details of one page.",
    { url: { type: "string" } }, ["url"]),
  tool("calculator", "Exact arithmetic, e.g. '125000 * 0.18' or 'round(sqrt(2), 3)'. Use instead of doing maths in your head.",
    { expression: { type: "string" } }, ["expression"]),
  tool("run_python", "Run Python 3 in the user's browser (no internet). Use it for calculations, data work, and to CREATE FILES: " +
    "Excel (openpyxl, pandas), Word (python-docx), PDF (fpdf2), PowerPoint (python-pptx), charts (matplotlib), CSV, ZIP. " +
    "Save files in the current folder with plain names; every new or changed file is shown to the user automatically. Print what you need to see.",
    { code: { type: "string" } }, ["code"]),
  tool("write_file", "Create or overwrite a text file (Markdown, CSV, HTML, code, JSON). It is shown to the user automatically.",
    { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  tool("read_file", "Read a text file you made earlier.", { path: { type: "string" } }, ["path"]),
  tool("list_files", "List the files made so far."),
  tool("screenshot", "Take a screenshot and have a vision model look at it, to check something visually. " +
    "target: a file you made (chart.png, quote.pdf, report.docx, sheet.xlsx, page.html, data.csv) or a web page URL (https://...). " +
    "question: exactly what to check, e.g. 'Is the title right, are axis labels readable, is anything cut off?'. " +
    "page: PDF page or Excel sheet number (default 1). Use it to verify visual files before finishing, and to see what a web page looks like.",
    { target: { type: "string" }, question: { type: "string" }, page: { type: "integer" } }, ["target", "question"]),
  tool("get_current_time", "Get the user's current local date and time."),
];

async function executeTool(name, rawArgs, ctx) {
  const fn = TOOL_FUNCTIONS[name];
  if (!fn) return `Error: unknown tool "${name}". Available: ${Object.keys(TOOL_FUNCTIONS).join(", ")}`;
  let args;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) throw new Error("arguments must be a JSON object");
  } catch (e) {
    return `Error: could not read tool arguments (${e.message}). Send valid JSON.`;
  }
  try {
    return truncate(await fn(args, ctx));
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return `Error while running ${name}: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Plain-English status for each step (what is actually happening)
// ---------------------------------------------------------------------------
const quote = (s, n = 60) => { s = String(s || "").trim(); return `“${s.length > n ? s.slice(0, n - 1) + "…" : s}”`; };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return "a web page"; } };
const FILE_RE = /['"]([\w\-./ ]+\.(?:xlsx|xls|csv|tsv|docx|pdf|pptx|png|jpe?g|svg|gif|webp|md|txt|html|json|zip))['"]/gi;
function filesInCode(code) {
  const found = [];
  for (const m of String(code || "").matchAll(FILE_RE)) if (!found.includes(m[1])) found.push(m[1].split("/").pop());
  return found;
}
const listNames = (names) => names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;

function describe(name, args, done) {
  const a = args || {};
  switch (name) {
    case "web_search": return `${done ? "Searched" : "Searching"} the web for ${quote(a.query)}`;
    case "fetch_webpage": return `${done ? "Read" : "Reading"} ${hostOf(a.url)}`;
    case "calculator": return `${done ? "Calculated" : "Calculating"} ${String(a.expression || "").slice(0, 60)}`;
    case "run_python": {
      const names = filesInCode(a.code);
      if (names.length) return `${done ? "Created" : "Creating"} ${listNames(names)}`;
      return done ? "Ran Python" : "Running Python";
    }
    case "write_file": return `${done ? "Wrote" : "Writing"} ${a.path || "a file"}`;
    case "read_file": return `${done ? "Read" : "Reading"} ${a.path || "a file"}`;
    case "list_files": return done ? "Checked the files" : "Checking the files";
    case "get_current_time": return done ? "Checked the date" : "Checking the date";
    case "screenshot": {
      const t = String(a.target || "");
      const what = /^https?:/i.test(t) ? hostOf(t) : t || "its work";
      return done ? `Took a screenshot of ${what} and checked it` : `Taking a screenshot of ${what}`;
    }
    default: return `${done ? "Used" : "Using"} ${name}`;
  }
}
const parseArgs = (raw) => { try { return JSON.parse(raw || "{}"); } catch (_) { return {}; } };

// The latest complete-ish sentence of the model's thinking, cleaned up for one status line.
function thoughtSnippet(text, max = 90) {
  const clean = String(text || "").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const parts = clean.split(/(?<=[.!?:;])\s+/).filter((p) => p.trim().length > 2);
  let s = parts[parts.length - 1] || clean;
  if (s.length < 24 && parts.length > 1) s = parts[parts.length - 2] + " " + s;   // too short to read on its own
  s = s.replace(/^(so|ok(ay)?|well|now|then|alright)[, ]+/i, "").trim();
  if (s.length > max) s = "…" + s.slice(s.length - max + 1).replace(/^\S*\s/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Read a string field out of JSON arguments that are still being written ("{"query": "rbi rep").
function partialField(raw, field) {
  const m = String(raw || "").match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return "";
  try { return JSON.parse(`"${m[1].replace(/\\$/, "")}"`); } catch (_) { return m[1]; }
}

// What a tool call looks like while the model is still writing it.
function describeForming(name, raw) {
  switch (name) {
    case "web_search": { const q = partialField(raw, "query"); return q ? `Planning a search for ${quote(q)}` : "Deciding what to search for"; }
    case "fetch_webpage": { const u = partialField(raw, "url"); return u.length > 10 ? `Opening ${hostOf(u)}` : "Picking a page to read"; }
    case "calculator": { const x = partialField(raw, "expression"); return x ? `Setting up ${x.slice(0, 50)}` : "Setting up a calculation"; }
    case "run_python": {
      const code = partialField(raw, "code");
      const lines = code ? code.split("\n").length : 0;
      const names = filesInCode(code);
      const what = names.length ? `code for ${listNames(names)}` : "Python code";
      return lines ? `Writing ${what} (${lines} line${lines === 1 ? "" : "s"})` : "Starting to write Python code";
    }
    case "write_file": {
      const p = partialField(raw, "path");
      const c = partialField(raw, "content");
      return p ? `Writing ${p}${c ? ` (${humanSize(enc.encode(c).length)})` : ""}` : "Starting a file";
    }
    case "read_file": { const p = partialField(raw, "path"); return p ? `Opening ${p}` : "Choosing a file to read"; }
    case "screenshot": {
      const t = partialField(raw, "target");
      const q = partialField(raw, "question");
      if (q) return `Deciding what to check: ${quote(q, 70)}`;
      return t ? `Getting ready to look at ${/^https?:/i.test(t) ? hostOf(t) : t}` : "Getting ready to take a screenshot";
    }
    default: return `Preparing ${name.replace(/_/g, " ")}`;
  }
}

// Which way the loader turns: tools that pull information in run it backwards; tools that make things run it forwards.
const PULL_TOOLS = new Set(["web_search", "fetch_webpage", "read_file", "list_files", "get_current_time", "screenshot"]);

function stepDetail(name, args, result) {
  if (name === "screenshot") return `Asked: ${args.question || "(no question)"}\n\n${result}`;
  if (name === "run_python") return `${args.code || ""}\n\n— Output —\n${result}`;
  if (name === "calculator") return `${args.expression} = ${result}`;
  if (name === "write_file") return result;
  return result;
}
const fmtDuration = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// ---------------------------------------------------------------------------
// System prompt + context management
// ---------------------------------------------------------------------------
function systemPrompt() {
  const now = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" });
  return `You are Mini Agent, a capable assistant that completes tasks by working in a loop: think about the next step, use a tool, look at the result, and repeat until the task is truly done.

Current date and time: ${now} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).

How to work:
- For anything about the present (prices, news, rates, who holds a role, latest versions), use web_search first. Do not rely on memory.
- For any number that matters, use calculator or run_python. Never do important maths in your head.
- If a tool returns an error, read it, fix your approach, and try again. Don't repeat the exact same failing call.
- Ask the user a question only when you truly cannot proceed without their input.

Making files (the user can preview, download and share them):
- You can make real files: Excel (.xlsx), Word (.docx), PDF, PowerPoint (.pptx), charts and images (.png), CSV, Markdown, HTML, JSON, code and ZIP.
- Build binary files with run_python and save them in the current folder with short, descriptive names (e.g. "gst_summary.xlsx"). Text files can also use write_file.
- Libraries: openpyxl or pandas for Excel (use real formulas, bold headers, sensible column widths, number formats); python-docx for Word; python-pptx for PowerPoint; fpdf2 for PDF; matplotlib for charts (plt.savefig("name.png", dpi=200, bbox_inches="tight")). They install automatically the first time.
- For fpdf2 PDFs, use the provided Unicode font so symbols like ₹ work: pdf.add_font("DejaVu", "", FONT_REGULAR); pdf.add_font("DejaVu", "B", FONT_BOLD); pdf.set_font("DejaVu", size=11).
- Python has no internet access. Get any data you need with web_search first, then put it in the code.
- After making a file, check it (reopen it in Python and print a short summary) before finishing.
- Files appear to the user automatically, so don't paste their contents into your answer. Name each file and say in a line what's in it.
- The user is usually on a phone. HTML files (games, pages, tools) open and run right inside this app when the user taps the file card, so say "tap the file to open it", not "double-click" or "drag into a browser". Make HTML pages work with touch and fit a phone screen.

Checking your work with screenshots:
- You have a screenshot tool. After you make a chart, PDF, Word, Excel, CSV or HTML file, take a screenshot of it and ask a specific question (is the title right, are labels readable, do the totals match, is anything cut off or empty).
- If the screenshot shows a problem, fix the file and check it again. Say briefly in your answer what you checked.
- To see what a web page looks like, screenshot its URL. The free web screenshot service allows about 25 a day, so use it only when looking matters.
- Don't take screenshots of plain text answers, and don't take more than you need.

When finished, give a clear, concise final answer in Markdown. Briefly say what you checked, and list source URLs if you used the web.`;
}

function trimHistory() {
  const size = () => state.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
  while (size() > MAX_HISTORY_CHARS) {
    const userIdx = state.history.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
    if (userIdx.length < 2) break;
    state.history.splice(userIdx[0], userIdx[1] - userIdx[0]);
  }
}

// ---------------------------------------------------------------------------
// THE AGENT LOOP
// ---------------------------------------------------------------------------
async function runTurn(text) {
  trimHistory();
  state.history.push({ role: "user", content: text });
  const userEntry = { kind: "user", text };
  state.log.push(userEntry);
  renderEntry(userEntry, true);

  const turn = { kind: "agent", text: "", steps: [], files: [], ms: 0 };
  const view = liveTurn(turn);
  const started = Date.now();
  const before = files.snapshot();

  rateNotice = (secs, n) => view.progress(`${provider().name} asked us to slow down. Trying again in ${secs}s${n > 1 ? ` (attempt ${n + 1})` : ""}`);
  state.running = true;
  state.abort = new AbortController();
  const signal = state.abort.signal;
  setRunningUI(true);
  let badCalls = 0;

  const finish = async (patch) => {
    Object.assign(turn, patch);
    turn.ms = Date.now() - started;
    turn.files = files.paths().filter((p) => before.get(p) !== files.get(p).mtime);
    await view.finish();
  };

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      // THINK (streamed, so the status can show what's actually going on)
      const thinkStart = Date.now();
      view.waiting(currentModel());
      let msg;
      try {
        msg = await streamLLM({
          model: currentModel(),
          messages: [{ role: "system", content: systemPrompt() }, ...state.history],
          tools: TOOLS, tool_choice: "auto", temperature: 0.3,
        }, signal, {
          reasoning: (chunk, all) => view.thinking(all, chunk.length),
          content: (chunk, all) => view.answer(all, chunk.length),
          tool: (call) => view.forming(call.function.name, call.function.arguments),
        });
      } catch (e) {
        if (e.code === "tool_use_failed" && badCalls < 2) {
          badCalls++;
          view.dropAnswer();
          view.addStep({ icon: "retry", label: "Retried a tool call that came out garbled", detail: e.message });
          state.history.push({ role: "user", content: "[harness note] Your last tool call was malformed and was not run. Retry with valid JSON arguments that match the tool's schema." });
          continue;
        }
        throw e;
      }

      if (msg.reasoning) {
        view.addStep({ icon: "think", label: `Thought for ${fmtDuration(Date.now() - thinkStart)}`, detail: msg.reasoning });
      }

      // ACT + OBSERVE
      if (msg.tool_calls && msg.tool_calls.length) {
        if (msg.content) {   // a note to itself before using a tool, not the final answer
          view.dropAnswer();
          view.addStep({ icon: "note", label: thoughtSnippet(msg.content, 70) || "Planned the next step", detail: msg.content });
        }
        state.history.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });
        for (const tc of msg.tool_calls) {
          const name = tc.function.name;
          const args = parseArgs(tc.function.arguments);
          view.running(name, args);
          let image = null;
          const result = await executeTool(name, tc.function.arguments, {
            signal,
            onProgress: (p) => view.progress(p === "Running Python" ? describe(name, args, false) : p),
            onImage: (src) => { image = src; view.peek(src); },
          });
          const failed = /^Error/.test(result) || /exit code: 1/.test(result);
          view.addStep({ icon: name, label: describe(name, args, true) + (failed ? " (hit an error)" : ""), detail: stepDetail(name, args, result), image });
          state.history.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }

      // CHECK -> DONE
      state.history.push({ role: "assistant", content: msg.content || "" });
      await finish({ text: msg.content || "(It finished without saying anything. Try rephrasing.)" });
      return;
    }
    state.history.push({ role: "assistant", content: `I stopped after ${MAX_STEPS} steps without finishing.` });
    await finish({ text: `I stopped after ${MAX_STEPS} steps without finishing. Say "continue" to let me keep going.` });
  } catch (e) {
    if (e.name === "AbortError") {
      const partial = view.partialAnswer();
      state.history.push({ role: "assistant", content: partial ? partial + "\n\n(The user stopped this reply.)" : "(The user stopped this request.)" });
      await finish({ text: partial, stopped: true });
    } else {
      if (state.history.length && state.history[state.history.length - 1].role === "user") state.history.pop();
      await finish({ kind: "error", text: e.message, retry: text });
    }
  } finally {
    rateNotice = null;
    state.running = false;
    state.abort = null;
    setRunningUI(false);
    save.chat();
    renderChatList();
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids) if (kid != null && kid !== false) node.append(kid);
  return node;
}
const svgNS = "http://www.w3.org/2000/svg";
const ICONS = {
  think: "M12 3a6 6 0 0 0-3.6 10.8c.4.3.6.8.6 1.3V17h6v-1.9c0-.5.2-1 .6-1.3A6 6 0 0 0 12 3ZM9.5 20h5",
  note: "M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5",
  retry: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
  web_search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4",
  fetch_webpage: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18",
  calculator: "M6 3h12v18H6zM9 7h6M9 11h.01M12 11h.01M15 11h.01M9 14h.01M12 14h.01M15 14h.01M9 17h.01M12 17h.01M15 17h.01",
  run_python: "M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12",
  write_file: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  read_file: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  list_files: "M3 6h7l2 2h9v11H3z",
  get_current_time: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2",
  screenshot: "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  chevron: "M9 6l6 6-6 6",
  alert: "M12 4 2.5 20h19ZM12 10v4M12 17h.01",
  share: "M12 3v12M8 7l4-4 4 4M5 12v8h14v-8",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
};
function icon(name, cls = "ico") {
  const s = document.createElementNS(svgNS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(svgNS, "path");
  p.setAttribute("d", ICONS[name] || ICONS.note);
  s.append(p);
  return s;
}

if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener"); }
  });
}
function mdHTML(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  const d = document.createElement("div"); d.textContent = text; return `<p style="white-space:pre-wrap">${d.innerHTML}</p>`;
}
function markdown(text) {
  const div = el("div", { class: "md" });
  div.innerHTML = mdHTML(text);
  return wireFiles(div);
}
// links and images that point at the agent's own files open the preview instead of a dead URL
function wireFiles(div) {
  for (const a of div.querySelectorAll("a[href]")) {
    const p = decodeURIComponent(a.getAttribute("href")).replace(/^\.?\//, "").replace(/^sandbox:\/?(mnt\/data\/)?/, "");
    if (files.has(p)) { a.removeAttribute("target"); a.addEventListener("click", (e) => { e.preventDefault(); openPreview(p); }); }
  }
  for (const img of div.querySelectorAll("img[src]")) {
    const p = decodeURIComponent(img.getAttribute("src")).replace(/^\.?\//, "");
    if (files.has(p)) img.src = fileUrl(p);
  }
  return div;
}

const ui = {
  chat: document.getElementById("chat"),
  thread: document.getElementById("thread"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("sendBtn"),
  subtitle: document.getElementById("subtitle"),
};
const nearBottom = () => ui.chat.scrollHeight - ui.chat.scrollTop - ui.chat.clientHeight < 160;
const scrollDown = (force) => { if (force || nearBottom()) ui.chat.scrollTop = ui.chat.scrollHeight; };

// ---------------------------------------------------------------------------
// The loader: your GIF, turning with the work.
//   clockwise        = making something (thinking, writing code or files, writing the answer)
//   counter-clockwise = pulling information in (web search, reading a page or file)
//   slow drift       = waiting for the model's first word
// Speed follows how fast text is arriving, plus a little more for every finished step.
// It eases between speeds (even through a change of direction) and spins down when done.
// ---------------------------------------------------------------------------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
// Each mood sets the spin (direction and base speed), the pulse (shape, depth, beats per second),
// the glow colour (picked from the colours in your animation), and the colour and see-through ranges:
// sat = [calm, peak] saturation, op = [calm, peak] opacity. Each frame sits somewhere between the
// two, set by the pulse, how fast text is arriving and any pop. Opacity never goes below 60%.
//   breath    = a slow, even swell
//   inhale    = it draws in (shrinks) on each beat: taking information in
//   heartbeat = a strong double beat that pushes out: making something
const LOADER_MOODS = {
  waiting: { dir: 1, base: 0.35, shape: "breath", amp: 0.06, hz: 0.55, glow: [70, 140, 255], sat: [0.35, 0.75], op: [0.6, 0.8] },
  thinking: { dir: 1, base: 0.8, shape: "breath", amp: 0.07, hz: 1.05, glow: [150, 110, 255], sat: [0.8, 1.35], op: [0.72, 0.95] },
  forming: { dir: 1, base: 1.1, shape: "breath", amp: 0.07, hz: 1.7, glow: [90, 190, 255], sat: [0.95, 1.5], op: [0.8, 1] },
  pull: { dir: -1, base: 1.6, shape: "inhale", amp: 0.12, hz: 1.25, glow: [40, 225, 190], sat: [1.1, 1.8], op: [0.62, 1], fade: true },
  make: { dir: 1, base: 2.0, shape: "heartbeat", amp: 0.14, hz: 1.1, glow: [255, 80, 190], sat: [1.2, 2.1], op: [0.85, 1] },
  answer: { dir: 1, base: 0.9, shape: "breath", amp: 0.05, hz: 0.9, glow: [60, 130, 255], sat: [0.9, 1.25], op: [0.85, 1] },
  done: { dir: 1, base: 0, shape: "breath", amp: 0, hz: 0.5, glow: [70, 140, 255], sat: [1, 1.2], op: [0.92, 1] },
};
const MIN_LOADER_OPACITY = 0.6;   // the spinner never fades past 60% while it works
const PULSE_SHAPES = {
  breath: (p) => (1 - Math.cos(2 * Math.PI * p)) / 2 - 0.35,
  inhale: (p) => -Math.pow(Math.sin(Math.PI * p), 3),
  heartbeat: (p) => Math.exp(-(((p - 0.06) / 0.055) ** 2)) + 0.65 * Math.exp(-(((p - 0.3) / 0.06) ** 2)),
};
function makeLoader() {
  const img = el("img", { class: "loader", src: reduceMotion ? "assets/loader-still.png" : "assets/loader.webp", alt: "" });
  const wrap = el("span", { class: "loader-wrap", "aria-hidden": "true" }, img);
  let anim = null;
  if (!reduceMotion && img.animate) {
    anim = img.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 2400, iterations: Infinity });
    anim.playbackRate = 0.35;
  }
  let mood = LOADER_MOODS.waiting;
  let flow = 0;          // smoothed characters per second arriving from the model
  let steps = 0;
  let rate = 0.35;       // current spin (negative = counter-clockwise)
  let phase = 0;         // where we are in the current pulse
  let amp = mood.amp, hz = mood.hz, shape = mood.shape;
  let kick = 0;          // extra swell from bursts of text and finished steps
  let glow = [...mood.glow];
  let sat = [...mood.sat], op = [...mood.op];   // ranges ease toward the mood's, like the glow
  let satNow = 1, opNow = 1;
  let pulseValue = 0;
  let raf = 0;
  let last = performance.now();
  let stopping = false;
  const tick = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    // spin
    flow *= Math.exp(-dt * 2.5);
    const boost = Math.min(2.4, Math.log2(1 + flow / 120));
    const target = mood.base === 0 ? 0 : mood.dir * (mood.base + boost) * (1 + Math.min(steps, 8) * 0.06);
    rate += (target - rate) * Math.min(1, dt * 4);
    if (anim) anim.playbackRate = Math.abs(rate) < 0.01 && target === 0 ? 0 : rate;
    // pulse: ease depth and tempo toward the mood; beats get quicker when text pours in
    amp += (mood.amp - amp) * Math.min(1, dt * 3);
    hz += (mood.hz * (1 + Math.min(0.8, boost * 0.25)) - hz) * Math.min(1, dt * 3);
    if (shape !== mood.shape && (phase % 1) < 0.08) shape = mood.shape;   // change shape on a beat boundary, no jolt
    phase = (phase + hz * dt) % 1;
    kick *= Math.exp(-dt * 6);
    const raw = PULSE_SHAPES[shape](phase);
    pulseValue = raw * amp;
    const scale = Math.max(0.82, Math.min(1.4, 1 + pulseValue + kick));
    for (let i = 0; i < 3; i++) glow[i] += (mood.glow[i] - glow[i]) * Math.min(1, dt * 3);
    const energy = Math.max(0, pulseValue / Math.max(amp, 0.01)) * 0.6 + Math.min(1, kick * 5);
    const blur = (2 + 7 * energy).toFixed(1);
    const alpha = (0.18 + 0.45 * Math.min(1, energy)).toFixed(2);
    // colour and see-through: how strong this beat is (0..1), plus how hard text is pouring in and any pop
    const beat = Math.max(0, Math.min(1, shape === "breath" ? raw + 0.35 : Math.abs(raw)));
    const level = Math.max(0, Math.min(1, 0.6 * beat + 0.3 * Math.min(1, boost / 2.4) + kick * 3));
    for (let i = 0; i < 2; i++) {
      sat[i] += (mood.sat[i] - sat[i]) * Math.min(1, dt * 3);
      op[i] += (mood.op[i] - op[i]) * Math.min(1, dt * 3);
    }
    satNow += (sat[0] + (sat[1] - sat[0]) * level - satNow) * Math.min(1, dt * 12);
    // searching "draws in": it turns more see-through on each inhale, then fills back in
    const opLevel = mood.fade ? Math.max(0, Math.min(1, 1 - beat + kick * 3)) : level;
    opNow += (op[0] + (op[1] - op[0]) * opLevel - opNow) * Math.min(1, dt * 12);
    opNow = Math.max(MIN_LOADER_OPACITY, Math.min(1, opNow));
    if (!stopping) {
      wrap.style.transform = `scale(${scale.toFixed(3)})`;
      wrap.style.filter = `drop-shadow(0 0 ${blur}px rgba(${glow.map((c) => c | 0).join(",")},${alpha}))`;
      img.style.filter = `saturate(${satNow.toFixed(2)})`;
      img.style.opacity = opNow.toFixed(2);
    }
    if (stopping && Math.abs(rate) < 0.02) { raf = 0; return; }
    raf = requestAnimationFrame(tick);
  };
  const run = () => { if (!reduceMotion && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  run();
  return {
    node: wrap,
    mood(name) { mood = LOADER_MOODS[name] || LOADER_MOODS.thinking; run(); },
    feed(chars) { flow += chars * 4; kick = Math.min(0.14, kick + chars / 700); run(); },   // every streamed chunk nudges it
    step() { steps++; kick = Math.min(0.3, kick + 0.22); run(); },                         // a finished step: a pop
    get direction() { return rate < 0 ? -1 : 1; },
    get rate() { return rate; },
    get scale() { return 1 + pulseValue + kick; },
    get saturation() { return satNow; },
    get opacity() { return opNow; },
    async spinDown() {
      mood = LOADER_MOODS.done; kick = Math.min(0.3, kick + 0.2); run();               // one last swell...
      await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 600));
      stopping = true;
      wrap.style.transform = "scale(0.4)";                                               // ...then it shrinks away
      wrap.classList.add("loader-out");
      await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 300));
      if (raf) cancelAnimationFrame(raf);
      if (anim) anim.cancel();
      wrap.remove();
    },
  };
}

// Swap a line of text with a soft crossfade (old line drifts up and fades, new one rises in).
// Each line says how long it must stay readable ("hold"): placeholders give way at once,
// a real thought stays about a second. Anything arriving sooner waits its turn, newest first.
function makeTicker(node) {
  let key = null;
  let holdUntil = 0;
  let queued = null;
  let timer = 0;
  const swap = (text, k, hold) => {
    key = k; holdUntil = performance.now() + hold;
    const prev = node.querySelector(".tick:not(.tick-out)");
    const next = el("span", { class: "tick" + (prev && !reduceMotion ? " tick-in" : "") }, text);
    if (prev) {
      if (reduceMotion) prev.remove();
      else { prev.classList.add("tick-out"); setTimeout(() => prev.remove(), 220); }
    }
    node.append(next);
  };
  const flush = () => {
    timer = 0;
    if (!queued) return;
    const [t, k, h] = queued; queued = null;
    swap(t, k, h);
  };
  return {
    set(text, k = text, hold = 0, force = false, maxWait = Infinity) {
      if (k === key && !queued) {              // same kind of status: just update the words in place
        const cur = node.querySelector(".tick:not(.tick-out)");
        if (cur) cur.textContent = text;
        return;
      }
      const wait = Math.min(holdUntil - performance.now(), maxWait);
      if (wait > 0 && !force) {
        queued = [text, k, hold];
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, wait);
        return;
      }
      if (timer) { clearTimeout(timer); timer = 0; queued = null; }
      swap(text, k, hold);
    },
    get text() { return (node.querySelector(".tick:not(.tick-out)") || {}).textContent || ""; },
  };
}

// Reveals streamed markdown smoothly: text is paced so bursts don't land all at once,
// finished blocks stay put, and each new paragraph, list or table fades in.
function makeStreamer(container) {
  let target = "";
  let shown = 0;
  let raf = 0;
  let lastParse = 0;
  let waiters = [];
  const render = (text) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = mdHTML(text);
    const fresh = [...tmp.children];
    const old = [...container.children];
    fresh.forEach((node, i) => {
      if (i < old.length - 1 && old[i].outerHTML === node.outerHTML) return;   // settled block, leave it alone
      if (i < old.length) {
        if (old[i].outerHTML !== node.outerHTML) {
          if (old[i].tagName === node.tagName) old[i].innerHTML = node.innerHTML; else old[i].replaceWith(node);
        }
      } else {
        if (!reduceMotion) node.classList.add("stream-in");
        container.append(node);
      }
    });
    for (let i = fresh.length; i < old.length; i++) old[i].remove();
  };
  const tick = (now) => {
    const backlog = target.length - shown;
    if (backlog > 0) {
      shown += reduceMotion ? backlog : Math.max(2, Math.ceil(backlog * 0.09));
      shown = Math.min(shown, target.length);
      if (now - lastParse > 32 || shown === target.length) { lastParse = now; render(target.slice(0, shown)); scrollDown(); }
    }
    if (shown >= target.length) {
      raf = 0;
      const w = waiters; waiters = []; w.forEach((r) => r());
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  return {
    set(text) { target = text; if (!raf) raf = requestAnimationFrame(tick); },
    settled() { return shown >= target.length ? Promise.resolve() : new Promise((r) => { waiters.push(r); if (!raf) raf = requestAnimationFrame(tick); }); },
    clear() { target = ""; shown = 0; container.replaceChildren(); },
    get text() { return target; },
  };
}

// ---------------------------------------------------------------------------
// Rendering the conversation
// ---------------------------------------------------------------------------
function stepRow(s, extraClass = "") {
  const label = s.label || s.title || "Step";   // `title` = older saved chats
  const row = el("li", { class: "step" + extraClass });
  const head = el("span", { class: "step-label" }, icon(s.icon || "note", "ico step-ico"), el("span", {}, label));
  if (s.detail) row.append(el("details", {}, el("summary", {}, head), el("pre", { class: "step-detail" }, truncate(s.detail, 5000))));
  else row.append(head);
  if (s.image) row.append(shotThumb(s.image, label));
  return row;
}
function shotThumb(src, label) {
  return el("button", { class: "shot-thumb", type: "button", "aria-label": `View screenshot: ${label}`, onclick: () => openImage(src, label) },
    el("img", { src, alt: "", loading: "lazy" }));
}
function stepsList(steps) {
  return el("ol", { class: "steps" }, ...steps.map((s) => stepRow(s)));
}

function activityNode(turn) {
  if (!turn.steps || !turn.steps.length) return null;
  const onlyThought = turn.steps.length === 1 && (turn.steps[0].icon === "think");
  const label = onlyThought ? turn.steps[0].label
    : turn.ms ? `Worked for ${fmtDuration(turn.ms)}` : `${turn.steps.length} step${turn.steps.length === 1 ? "" : "s"}`;   // older chats have no timing
  return el("details", { class: "activity" },
    el("summary", {}, el("span", { class: "activity-label" }, label), icon("chevron", "ico chev")),
    stepsList(turn.steps));
}

function fileCard(path) {
  const f = files.get(path);
  const info = fileInfo(path);
  const name = path.split("/").pop();
  if (!f) {
    return el("div", { class: "file-card gone" }, el("span", { class: `file-badge k-${info.kind}` }, info.ext.toUpperCase().slice(0, 4) || "FILE"),
      el("span", { class: "file-meta" }, el("span", { class: "file-name" }, name), el("span", { class: "file-sub" }, "Deleted")));
  }
  const meta = el("span", { class: "file-meta" }, el("span", { class: "file-name" }, name),
    el("span", { class: "file-sub" }, `${info.label}, ${humanSize(f.bytes.length)}`));
  const badge = el("span", { class: `file-badge k-${info.kind}`, "aria-hidden": "true" }, info.ext.toUpperCase().slice(0, 4) || "FILE");
  return el("button", { class: "file-card", type: "button", onclick: () => openPreview(path), "aria-label": `Open ${name}` },
    badge, meta, icon("chevron", "ico chev"));
}

function filesNode(paths) {
  if (!paths || !paths.length) return null;
  const wrap = el("div", { class: "files" });
  for (const p of paths) {
    if (fileInfo(p).kind === "image" && files.has(p)) {
      wrap.append(el("button", { class: "image-card", type: "button", onclick: () => openPreview(p), "aria-label": `Open ${p}` },
        el("img", { src: fileUrl(p), alt: p.split("/").pop(), loading: "lazy" })));
    }
  }
  const cards = paths.filter((p) => !(fileInfo(p).kind === "image" && files.has(p)));   // images are already shown big
  if (cards.length) wrap.append(el("div", { class: "file-list" }, ...cards.map(fileCard)));
  return wrap;
}

function leaveEmpty() {
  const empty = document.querySelector(".empty");
  if (!empty) return;
  if (reduceMotion) { empty.remove(); return; }
  empty.classList.add("empty-out");
  setTimeout(() => empty.remove(), 260);
}

function renderEntry(entry, animate = false) {
  if (animate) leaveEmpty(); else document.querySelector(".empty")?.remove();
  if (entry.kind === "user") {
    ui.thread.append(el("div", { class: "row user" + (animate && !reduceMotion ? " bubble-in" : "") }, el("div", { class: "bubble" }, entry.text)));
    scrollDown(true);
    return;
  }
  const turn = el("div", { class: "row agent" });
  const act = activityNode(entry);
  if (act) turn.append(act);
  if (entry.kind === "error") {
    turn.append(el("div", { class: "error", role: "alert" }, icon("alert", "ico err-ico"),
      el("div", {}, el("p", {}, entry.text),
        entry.retry ? el("button", { class: "text-btn", type: "button", onclick: () => submit(entry.retry) }, "Try again") : null)));
  } else if (entry.stopped) {
    turn.append(el("p", { class: "muted" }, "Stopped."));
  } else if (entry.text) {
    turn.append(markdown(entry.text));
  }
  const fl = filesNode(entry.files);
  if (fl) turn.append(fl);
  ui.thread.append(turn);
  scrollDown();
}

// The turn that's in progress. It stays on screen and settles into its final form in place,
// so nothing is swapped out or jumps when the answer lands.
function liveTurn(turn) {
  const loader = makeLoader();
  const statusBox = el("span", { class: "status-text" });
  const ticker = makeTicker(statusBox);
  const summary = el("summary", {}, loader.node, statusBox, icon("chevron", "ico chev"));
  const steps = el("ol", { class: "steps" });
  const live = el("details", { class: "activity live" }, summary, steps);
  const answerBox = el("div", { class: "md streaming" });
  const row = el("div", { class: "row agent" + (reduceMotion ? "" : " turn-in") }, live, answerBox);
  ui.thread.append(row);
  scrollDown(true);
  const streamer = makeStreamer(answerBox);
  const shortModel = (m) => m.split("/").pop();
  let phase = "";
  let thoughtShown = "";

  const setStatus = (text, key, hold, force, maxWait) => { ticker.set(text, key, hold, force, maxWait); scrollDown(); };
  const addStepRow = (s) => steps.append(stepRow(s, reduceMotion ? "" : " step-in"));
  let peekEl = null;

  return {
    waiting(model) {
      phase = "waiting"; thoughtShown = "";
      loader.mood("waiting");
      setStatus(turn.steps.length ? `Waiting for ${shortModel(model)} to decide the next step` : `Waiting for ${shortModel(model)}`, "waiting");
    },
    thinking(all, chars) {
      loader.feed(chars);
      if (phase !== "thinking") { phase = "thinking"; loader.mood("thinking"); setStatus("Thinking", "thinking-start"); }
      // only show finished sentences, so a thought never appears half-written
      const sentence = thoughtSnippet(all.replace(/[^.!?:;\n]*$/, ""));
      if (!sentence || sentence.length < 16 || sentence === thoughtShown) return;
      thoughtShown = sentence;
      setStatus(sentence, "thought:" + sentence, 1100);   // stays at least ~1s so it can be read
    },
    forming(name, raw) {
      loader.feed(8);
      if (phase !== "forming") { phase = "forming"; loader.mood("forming"); }
      setStatus(describeForming(name, raw), "forming:" + name, 600);
    },
    running(name, args) {
      phase = "running";
      loader.mood(PULL_TOOLS.has(name) ? "pull" : "make");
      setStatus(describe(name, args, false), "run:" + name + JSON.stringify(args).slice(0, 80), 700, false, 350);   // real actions cut in quickly
    },
    progress(text) { setStatus(text, "progress:" + text, 500); },
    answer(all, chars) {
      loader.feed(chars);
      if (phase !== "answer") { phase = "answer"; loader.mood("answer"); setStatus("Writing the answer", "answer", 0); }
      streamer.set(all);
    },
    dropAnswer() {                       // text that turned out to be a note before a tool call
      if (!streamer.text) return;
      if (reduceMotion) { streamer.clear(); return; }
      answerBox.classList.add("fade-away");
      setTimeout(() => { streamer.clear(); answerBox.classList.remove("fade-away"); }, 220);
    },
    partialAnswer() { return streamer.text; },
    peek(src) {                          // show the screenshot under the status line while it's being checked
      if (peekEl) peekEl.remove();
      peekEl = el("div", { class: "shot-peek" + (reduceMotion ? "" : " rise-in") }, el("img", { src, alt: "Screenshot being checked" }));
      live.after(peekEl);
      scrollDown();
    },
    addStep(step) {
      if (peekEl && step.image) { peekEl.remove(); peekEl = null; }
      turn.steps.push(step);
      addStepRow(step);
      loader.step();
      scrollDown();
    },
    async finish() {
      if (peekEl) { peekEl.remove(); peekEl = null; }
      // 1) let the answer finish flowing in
      if (turn.kind !== "error" && turn.text) {
        streamer.set(turn.text);
        await streamer.settled();
      }
      // 2) the status line settles into a summary, and the loader spins down
      const onlyThought = turn.steps.length === 1 && turn.steps[0].icon === "think";
      const label = turn.kind === "error" ? (turn.steps.length ? `Worked for ${fmtDuration(turn.ms)}` : "")
        : turn.stopped ? "Stopped"
        : !turn.steps.length ? ""
        : onlyThought ? turn.steps[0].label : `Worked for ${fmtDuration(turn.ms)}`;
      const spin = loader.spinDown();
      if (label) ticker.set(label, "final", 0, true);
      live.classList.remove("live");
      if (!label) {
        if (reduceMotion) live.remove();
        else {   // fold the status row away smoothly (height can't animate from "auto", so pin it first)
          live.style.overflow = "hidden";
          live.style.maxHeight = live.offsetHeight + "px";
          void live.offsetHeight;
          live.style.transition = "max-height 340ms ease, opacity 220ms ease, margin 340ms ease";
          live.style.maxHeight = "0px"; live.style.opacity = "0"; live.style.marginBottom = "-12px";
          setTimeout(() => live.remove(), 380);
        }
      }
      // 3) final content: the answer re-rendered with working file links, or the error
      answerBox.classList.remove("streaming");
      if (turn.kind === "error") {
        answerBox.replaceWith(el("div", { class: "error" + (reduceMotion ? "" : " fade-in"), role: "alert" }, icon("alert", "ico err-ico"),
          el("div", {}, el("p", {}, turn.text),
            turn.retry ? el("button", { class: "text-btn", type: "button", onclick: () => submit(turn.retry) }, "Try again") : null)));
      } else if (turn.text) {
        answerBox.innerHTML = mdHTML(turn.text);
        wireFiles(answerBox);
      } else answerBox.remove();
      // 4) files rise in one after another
      const fl = filesNode(turn.files);
      if (fl) {
        if (!reduceMotion) [...fl.querySelectorAll(".image-card, .file-card")].forEach((n, i) => { n.classList.add("rise-in"); n.style.animationDelay = `${i * 70}ms`; });
        row.append(fl);
      }
      row.classList.remove("turn-in");
      state.log.push(turn);
      scrollDown();
      spin.catch(() => {});   // the loader winds down on its own; the app is ready for the next message right away
    },
  };
}

const EXAMPLES = [
  ["Make an Excel GST calculator", "Make an Excel sheet that calculates 18% GST for 10 sample invoices, with totals and proper formatting"],
  ["Chart India's GDP growth", "Look up India's GDP growth for the last 5 years and make a bar chart"],
  ["Write a quotation as PDF", "Write a one-page quotation PDF for 20 hospital beds at ₹45,000 each plus 18% GST"],
  ["Today's repo rate", "What's India's current repo rate, and what changed at the last RBI meeting?"],
];

function renderEmpty() {
  const wrap = el("section", { class: "empty" });
  wrap.append(el("img", { class: "empty-mark", src: "assets/loader-still.png", alt: "" }));
  if (!apiKey()) {
    const input = el("input", { type: "password", placeholder: "gsk_... or sk-or-...", "aria-label": "Groq or OpenRouter API key", spellcheck: "false", autocapitalize: "off", autocomplete: "off" });
    const error = el("p", { class: "field-error", role: "alert" });
    const saveKey = () => {
      const v = input.value.trim();
      if (!v) { error.textContent = "Paste a key first."; input.focus(); return; }
      const p = detectProvider(v);
      if (!p) { error.textContent = "That doesn't look like a Groq key (gsk_...) or an OpenRouter key (sk-or-...). For other keys, use Settings."; input.focus(); return; }
      state.settings.provider = p;
      state.settings.keys[p] = v;
      save.settings(); updateSubtitle(); renderAll(); ui.input.focus();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveKey(); } });
    input.addEventListener("input", () => { error.textContent = ""; });
    const link = (p, t) => el("a", { href: PROVIDERS[p].keyLink, target: "_blank", rel: "noopener" }, t);
    wrap.append(
      el("h2", {}, "Add an API key"),
      el("p", { class: "lede" }, "Paste a Groq or OpenRouter key. It's saved only on this device."),
      el("div", { class: "key-card" }, input, el("button", { class: "btn-primary", type: "button", onclick: saveKey }, "Continue")),
      error,
      el("p", { class: "footnote" }, "Get a key from ", link("groq", "Groq"), " (free tier) or ", link("openrouter", "OpenRouter"), "."));
  } else {
    wrap.append(
      el("h2", {}, "What can I help with?"),
      el("div", { class: "suggestions" }, ...EXAMPLES.map(([title, prompt]) =>
        el("button", { class: "suggestion", type: "button", onclick: () => submit(prompt) }, title))));
  }
  ui.thread.append(wrap);
}

function renderAll() {
  ui.thread.replaceChildren();
  if (!state.log.length) renderEmpty();
  for (const entry of state.log) renderEntry(entry);
  scrollDown(true);
}

function setRunningUI(running) {
  ui.send.classList.toggle("stop", running);
  ui.send.setAttribute("aria-label", running ? "Stop" : "Send");
  updateSendState();
}
function updateSendState() {
  ui.send.disabled = !state.running && !ui.input.value.trim();
}
function updateSubtitle() {
  ui.subtitle.textContent = apiKey() ? `${provider().name}, ${currentModel().split("/").pop()}` : "No key yet";
}

// ---------------------------------------------------------------------------
// File preview sheet
// ---------------------------------------------------------------------------
const libs = {};
function loadScript(src) {
  if (!libs[src]) {
    libs[src] = new Promise((resolve, reject) => {
      const s = el("script", { src, crossorigin: "anonymous" });
      s.onload = resolve; s.onerror = () => { delete libs[src]; reject(new Error("Couldn't load the previewer.")); };
      document.head.append(s);
    });
  }
  return libs[src];
}
const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const MAMMOTH_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.13.0/mammoth.browser.min.js";

function parseCSV(text, sep) {
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      if (rows.length > 300) break;
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function tableFrom(rows) {
  const [head, ...body] = rows;
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ...(head || []).map((h) => el("th", {}, h)))),
    el("tbody", {}, ...body.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, c)))))));
}
function unavailable(msg) {
  return el("div", { class: "preview-none" }, icon("file", "ico big-ico"), el("p", {}, msg));
}

async function buildPreview(path, body) {
  const f = files.get(path);
  const info = fileInfo(path);
  const url = fileUrl(path);
  try {
    if (info.kind === "image") { body.replaceChildren(el("img", { class: "preview-img", src: url, alt: path })); return; }
    if (info.ext === "pdf") {          // draw the pages with pdf.js, so it looks the same on every phone and browser
      body.replaceChildren(el("p", { class: "muted center" }, "Opening PDF…"));
      const pdfjs = await import(PDFJS_URL);
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      const task = pdfjs.getDocument({ data: f.bytes.slice() });
      const doc = await task.promise;
      const pages = el("div", { class: "pdf-pages" });
      body.replaceChildren(pages);
      const shown = Math.min(doc.numPages, 30);
      const width = Math.min(body.clientWidth || 360, 760);
      for (let n = 1; n <= shown; n++) {
        if (previewPath !== path || !previewDlg.open) break;          // closed or switched while drawing
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = el("canvas", { class: "pdf-page", "aria-label": `Page ${n}` });
        canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
        canvas.style.width = width + "px";
        pages.append(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
      if (doc.numPages > shown) pages.append(el("p", { class: "muted center" }, `Showing the first ${shown} of ${doc.numPages} pages. Download it to see the rest.`));
      try { await task.destroy(); } catch (_) { /* fine */ }
      return;
    }
    if (info.ext === "csv" || info.ext === "tsv") { body.replaceChildren(tableFrom(parseCSV(dec.decode(f.bytes), info.ext === "tsv" ? "\t" : ","))); return; }
    if (info.ext === "md") { body.replaceChildren(markdown(dec.decode(f.bytes))); return; }
    if (info.ext === "html" || info.ext === "htm") {
      body.replaceChildren(el("iframe", { class: "preview-frame", sandbox: "allow-scripts", srcdoc: dec.decode(f.bytes), title: path }));
      return;
    }
    if (isTextual(path)) { body.replaceChildren(el("pre", { class: "preview-code" }, truncate(dec.decode(f.bytes), 200000))); return; }
    if (info.ext === "xlsx" || info.ext === "xls") {
      body.replaceChildren(el("p", { class: "muted center" }, "Opening spreadsheet…"));
      await loadScript(XLSX_URL);
      const wb = XLSX.read(f.bytes, { type: "array" });
      const show = (name) => {
        fillFormulas(wb.Sheets[name]);
        const html = XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false });
        const holder = el("div", { class: "table-wrap xls" });
        holder.innerHTML = DOMPurify.sanitize(html);
        return holder;
      };
      const tabs = wb.SheetNames.length > 1
        ? el("div", { class: "segmented small", role: "tablist" }, ...wb.SheetNames.map((n, i) =>
          el("button", { type: "button", role: "tab", "aria-selected": i === 0 ? "true" : "false", onclick: (e) => {
            for (const b of e.currentTarget.parentNode.children) b.setAttribute("aria-selected", "false");
            e.currentTarget.setAttribute("aria-selected", "true");
            body.lastChild.replaceWith(show(n));
          } }, n)))
        : null;
      body.replaceChildren(...[tabs, show(wb.SheetNames[0])].filter(Boolean));
      return;
    }
    if (info.ext === "docx") {
      body.replaceChildren(el("p", { class: "muted center" }, "Opening document…"));
      await loadScript(MAMMOTH_URL);
      const res = await mammoth.convertToHtml({ arrayBuffer: f.bytes.slice().buffer });
      const page = el("div", { class: "paper md" });
      page.innerHTML = DOMPurify.sanitize(res.value);
      body.replaceChildren(page);
      return;
    }
    if (info.ext === "pptx") { body.replaceChildren(unavailable("PowerPoint files can't be previewed here. Share or download it to open in Keynote or PowerPoint.")); return; }
    body.replaceChildren(unavailable(`${info.label} files can't be previewed here. Share or download it to open it.`));
  } catch (e) {
    body.replaceChildren(unavailable(`Couldn't show a preview (${e.message}). You can still share or download it.`));
  }
}

const previewDlg = document.getElementById("preview");
let previewPath = null;
function openPreview(path) {
  if (!files.has(path)) return;
  previewPath = path;
  const f = files.get(path);
  document.getElementById("previewTitle").textContent = path.split("/").pop();
  document.getElementById("previewSub").textContent = `${fileInfo(path).label}, ${humanSize(f.bytes.length)}`;
  const body = document.getElementById("previewBody");
  body.replaceChildren();
  document.getElementById("shareBtn").hidden = !canShareFile(path);
  document.getElementById("deleteBtn").hidden = false;
  delete document.getElementById("downloadBtn").dataset.src;
  previewDlg.showModal();
  buildPreview(path, body);
}
// View a screenshot full size (reuses the preview sheet, without the file-only buttons).
function openImage(src, title) {
  previewPath = null;
  document.getElementById("previewTitle").textContent = "Screenshot";
  document.getElementById("previewSub").textContent = title;
  document.getElementById("previewBody").replaceChildren(el("img", { class: "preview-img", src, alt: title }));
  document.getElementById("shareBtn").hidden = true;
  document.getElementById("deleteBtn").hidden = true;
  const dl = document.getElementById("downloadBtn");
  dl.dataset.src = src;
  previewDlg.showModal();
}
function fileObject(path) {
  const f = files.get(path);
  return new File([f.bytes], path.split("/").pop(), { type: fileInfo(path).mime });
}
function canShareFile(path) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [fileObject(path)] })); } catch (_) { return false; }
}
function downloadFile(path) {
  const a = el("a", { href: fileUrl(path), download: path.split("/").pop() });
  document.body.append(a); a.click(); a.remove();
}
document.getElementById("shareBtn").addEventListener("click", async () => {
  try { await navigator.share({ files: [fileObject(previewPath)], title: previewPath }); }
  catch (e) { if (e.name !== "AbortError") downloadFile(previewPath); }
});
document.getElementById("downloadBtn").addEventListener("click", (e) => {
  const src = e.currentTarget.dataset.src;
  if (src) {                             // a screenshot
    const a = el("a", { href: src, download: "screenshot.jpg", target: "_blank", rel: "noopener" });
    document.body.append(a); a.click(); a.remove();
    return;
  }
  downloadFile(previewPath);
});
document.getElementById("deleteBtn").addEventListener("click", () => {
  files.remove(previewPath);
  previewDlg.close();
  renderAll();
  renderSettingsFiles();
});
document.getElementById("previewDone").addEventListener("click", () => previewDlg.close());
previewDlg.addEventListener("click", (e) => { if (e.target === previewDlg) previewDlg.close(); });

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
function submit(text) {
  text = (text || "").trim();
  if (!text || state.running) return;
  if (!apiKey()) {
    if (state.log.length) { openSettings(); return; }
    renderAll(); document.querySelector(".empty input")?.focus(); return;
  }
  ui.input.value = ""; autosize(); updateSendState();
  if (!state.chat) {                     // a new conversation becomes a saved chat on its first message
    const chat = chats.create(text);
    state.chat = chat; state.history = chat.history; state.log = chat.log; files.scope = chat.id;
    store.set("ma.currentChat", chat.id);
    chats.save(chat);
  }
  runTurn(text);
}

ui.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.running) { state.abort?.abort(); python.kill(); return; }
  submit(ui.input.value);
});
const coarse = matchMedia("(pointer: coarse)").matches;
ui.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); ui.form.requestSubmit(); }
});
function autosize() { ui.input.style.height = "auto"; ui.input.style.height = Math.min(ui.input.scrollHeight, 168) + "px"; }
ui.input.addEventListener("input", () => { autosize(); updateSendState(); });

document.getElementById("newChatBtn").addEventListener("click", () => newChat());


// ---------------------------------------------------------------------------
// Chat history: open, switch, start and delete conversations
// ---------------------------------------------------------------------------
function openChat(chat, animate = true) {
  state.chat = chat;
  state.history = chat ? chat.history : [];
  state.log = chat ? chat.log : [];
  files.scope = chat ? chat.id : null;
  store.set("ma.currentChat", chat ? chat.id : "");
  if (animate && !reduceMotion) {
    ui.thread.classList.remove("thread-in");
    ui.thread.classList.add("thread-out");
    setTimeout(() => {
      renderAll();
      ui.thread.classList.remove("thread-out");
      void ui.thread.offsetWidth;
      ui.thread.classList.add("thread-in");
    }, 170);
  } else renderAll();
  renderChatList();
}

function newChat() {
  if (state.running) { flashNote("Finish or stop the current reply first."); return; }
  closeDrawer();
  if (!state.chat) { ui.input.focus(); return; }
  openChat(null);
  ui.input.focus();
}

const drawer = document.getElementById("drawer");
const scrim = document.getElementById("scrim");
const chatSearch = document.getElementById("chatSearch");
const chatListEl = document.getElementById("chatList");
const editBtn = document.getElementById("editChats");

function openDrawer() {
  renderChatList();
  drawer.classList.add("open");
  drawer.removeAttribute("inert");
  drawer.setAttribute("aria-hidden", "false");
  scrim.classList.add("show");
  document.querySelector(".app").classList.add("pushed");
}
function closeDrawer() {
  drawer.classList.remove("open", "editing");
  drawer.setAttribute("inert", "");
  drawer.setAttribute("aria-hidden", "true");
  scrim.classList.remove("show");
  document.querySelector(".app").classList.remove("pushed");
  editBtn.textContent = "Edit";
}

let noteTimer = 0;
function flashNote(text) {
  const note = document.getElementById("drawerNote");
  note.textContent = text;
  note.classList.add("show");
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => note.classList.remove("show"), 2600);
  if (!drawer.classList.contains("open")) {           // the drawer is closed, so say it in the status bar instead
    ui.subtitle.textContent = text;
    setTimeout(updateSubtitle, 2600);
  }
}

const DAY = 86400000;
function dayGroup(ts) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= today) return "Today";
  if (ts >= today - DAY) return "Yesterday";
  if (ts >= today - 6 * DAY) return "Previous 7 days";
  if (ts >= today - 29 * DAY) return "Previous 30 days";
  return new Date(ts).toLocaleString("en-IN", { month: "long", year: "numeric" });
}
function timeLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (now - d < 6 * DAY) return d.toLocaleDateString("en-IN", { weekday: "short" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
const plain = (t) => String(t || "").replace(/[*_`#>|[\]()-]+/g, " ").replace(/\s+/g, " ").trim();
function chatPreview(c) {
  for (let i = c.log.length - 1; i >= 0; i--) {
    const e = c.log[i];
    if (e.kind !== "user" && e.text) return plain(e.text).slice(0, 80);
    if (e.kind !== "user" && e.files && e.files.length) return `Made ${e.files.join(", ")}`.slice(0, 80);
  }
  const n = files.paths(c.id).length;
  return n ? `${n} file${n === 1 ? "" : "s"}` : "";
}
const chatText = (c) => (c.title + " " + c.log.map((e) => e.text || "").join(" ") + " " + files.paths(c.id).join(" ")).toLowerCase();

function renderChatList() {
  const q = chatSearch.value.trim().toLowerCase();
  const list = chats.sorted()
    .filter((c) => c.log.length || files.paths(c.id).length)
    .filter((c) => !q || chatText(c).includes(q));
  chatListEl.replaceChildren();
  if (!list.length) {
    chatListEl.append(el("p", { class: "list-empty" }, q ? `No chats match “${chatSearch.value.trim()}”.` : "No chats yet. Your conversations will appear here."));
    return;
  }
  let group = null;
  let cells = null;
  for (const c of list) {
    const g = dayGroup(c.updated);
    if (g !== group) {
      group = g;
      chatListEl.append(el("div", { class: "list-head" }, g));
      cells = el("div", { class: "cells chat-cells" });
      chatListEl.append(cells);
    }
    const active = state.chat && state.chat.id === c.id;
    const row = el("div", { class: "chat-row" + (active ? " active" : "") });
    row.append(
      el("button", { class: "chat-open", type: "button", "aria-current": active ? "true" : null, onclick: () => selectChat(c.id) },
        el("span", { class: "chat-title" }, c.title),
        el("span", { class: "chat-sub" }, el("span", { class: "chat-time" }, timeLabel(c.updated)), " ", chatPreview(c))),
      el("button", { class: "chat-del", type: "button", "aria-label": `Delete “${c.title}”`, onclick: () => deleteChat(c.id, row) }, "Delete"));
    cells.append(row);
  }
}

function selectChat(id) {
  const chat = chats.list.get(id);
  if (!chat) return;
  if (state.chat && state.chat.id === id) { closeDrawer(); return; }
  if (state.running) { flashNote("Finish or stop the current reply first."); return; }
  closeDrawer();
  openChat(chat);
}

function deleteChat(id, row) {
  if (state.running && state.chat && state.chat.id === id) { flashNote("Stop the reply before deleting this chat."); return; }
  const finish = () => {
    chats.remove(id);
    if (state.chat && state.chat.id === id) openChat(null);
    renderChatList();
  };
  if (reduceMotion) { finish(); return; }
  row.style.height = row.offsetHeight + "px";
  void row.offsetHeight;
  row.classList.add("row-out");
  setTimeout(finish, 300);
}

document.getElementById("menuBtn").addEventListener("click", openDrawer);
scrim.addEventListener("click", closeDrawer);
document.getElementById("drawerNew").addEventListener("click", () => newChat());
document.getElementById("settingsBtn").addEventListener("click", () => { closeDrawer(); openSettings(); });
chatSearch.addEventListener("input", renderChatList);
editBtn.addEventListener("click", () => {
  const on = drawer.classList.toggle("editing");
  editBtn.textContent = on ? "Done" : "Edit";
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer(); });

// ---------------------------------------------------------------------------
// Settings sheet (edits a draft; Done applies it)
// ---------------------------------------------------------------------------
const settingsDlg = document.getElementById("settings");
const f = {
  key: document.getElementById("keyInput"),
  custom: document.getElementById("customModel"),
  vision: document.getElementById("visionList"),
  customVision: document.getElementById("customVision"),
  ask: document.getElementById("askInput"),
  relay: document.getElementById("relayInput"),
  seg: document.getElementById("providerSeg"),
  models: document.getElementById("modelList"),
};
let draft = null;

function stashFields() {
  draft.keys[draft.provider] = f.key.value.trim();
  for (const [kind, c] of Object.entries(CHOICES)) {
    const typed = c.other().value.trim();
    if (typed) draft[kind][draft.provider] = typed;
  }
}
// The main model and the vision model are both a short pick-list plus an "other" field.
const CHOICES = {
  models: { list: (P) => P.models, def: (P) => P.defaultModel, box: () => f.models, other: () => f.custom },
  visionModels: { list: (P) => P.visionModels, def: (P) => P.visionModel, box: () => f.vision, other: () => f.customVision },
};
function renderChoices(kind) {
  const c = CHOICES[kind];
  const P = PROVIDERS[draft.provider];
  const current = draft[kind][draft.provider] || c.def(P);
  const known = c.list(P).some(([id]) => id === current);
  const choose = (id) => { draft[kind][draft.provider] = id; c.other().value = ""; renderChoices(kind); };
  c.box().replaceChildren(...c.list(P).map(([id, label]) => el("button", { class: "cell cell-choice", type: "button", role: "radio",
    "aria-checked": String(id === current), onclick: () => choose(id) },
    el("span", { class: "cell-text" }, el("span", {}, id.split("/").pop()), el("span", { class: "cell-sub" }, label)),
    el("span", { class: "check", "aria-hidden": "true" }, id === current ? "✓" : ""))));
  c.other().value = known ? "" : current;
}
function renderModels() { renderChoices("models"); renderChoices("visionModels"); }
function showProvider(p) {
  draft.provider = p;
  const P = PROVIDERS[p];
  for (const b of f.seg.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.p === p));
  f.key.value = draft.keys[p] || "";
  f.key.placeholder = P.keyPrefix + "...";
  document.getElementById("keyFooter").replaceChildren(`Saved only on this device and sent only to ${P.name}. `,
    el("a", { href: P.keyLink, target: "_blank", rel: "noopener" }, `Get a ${P.name} key`));
  document.getElementById("relayGroup").hidden = p !== "groq";
  document.getElementById("forgetBtn").textContent = `Forget ${P.name} key`;
  renderModels();
}
function renderSettingsFiles() {
  const list = document.getElementById("fileRows");
  const paths = files.paths();
  document.getElementById("filesGroup").hidden = !paths.length;
  list.replaceChildren(...paths.map((p) => {
    const info = fileInfo(p);
    return el("button", { class: "cell cell-file", type: "button", onclick: () => { openPreview(p); } },
      el("span", { class: `file-badge small k-${info.kind}`, "aria-hidden": "true" }, info.ext.toUpperCase().slice(0, 4)),
      el("span", { class: "cell-text" }, el("span", {}, p), el("span", { class: "cell-sub" }, humanSize(files.get(p).bytes.length))),
      icon("chevron", "ico chev"));
  }));
}
function openSettings() {
  draft = {
    provider: state.settings.provider,
    keys: Object.assign({}, state.settings.keys),
    models: Object.assign({}, state.settings.models),
    visionModels: Object.assign({}, state.settings.visionModels),
  };
  f.key.type = "password";
  document.getElementById("toggleKey").textContent = "Show";
  showProvider(draft.provider);
  f.ask.checked = state.settings.askBeforeCode;
  f.relay.value = state.settings.relayUrl;
  renderSettingsFiles();
  settingsDlg.showModal();
}
function applySettings() {
  if (!draft) return;
  stashFields();
  const hadKey = !!apiKey();
  state.settings.provider = draft.provider;
  for (const p of Object.keys(PROVIDERS)) {
    state.settings.keys[p] = draft.keys[p] || "";
    state.settings.models[p] = draft.models[p] || PROVIDERS[p].defaultModel;
    state.settings.visionModels[p] = draft.visionModels[p] || PROVIDERS[p].visionModel;
  }
  state.settings.askBeforeCode = f.ask.checked;
  state.settings.relayUrl = f.relay.value.trim();
  save.settings();
  draft = null;
  updateSubtitle();
  if (hadKey !== !!apiKey() && !state.log.length) renderAll();
}

document.getElementById("titleBtn").addEventListener("click", openSettings);
document.getElementById("settingsDone").addEventListener("click", () => { applySettings(); settingsDlg.close(); });
settingsDlg.addEventListener("cancel", () => applySettings());
settingsDlg.addEventListener("click", (e) => { if (e.target === settingsDlg) { applySettings(); settingsDlg.close(); } });
for (const b of f.seg.querySelectorAll("button")) b.addEventListener("click", () => { stashFields(); showProvider(b.dataset.p); });
f.key.addEventListener("input", () => {
  const v = f.key.value.trim();
  const p = detectProvider(v);
  if (p && p !== draft.provider) {
    f.key.value = draft.keys[draft.provider] || "";
    stashFields();
    draft.keys[p] = v;
    showProvider(p);
  }
});
for (const [kind, c] of Object.entries(CHOICES)) {
  c.other().addEventListener("input", () => {
    for (const b of c.box().querySelectorAll(".cell-choice")) { b.setAttribute("aria-checked", "false"); b.querySelector(".check").textContent = ""; }
    if (!c.other().value.trim()) { draft[kind][draft.provider] = ""; renderChoices(kind); }
  });
}
document.getElementById("toggleKey").addEventListener("click", (e) => {
  const show = f.key.type === "password";
  f.key.type = show ? "text" : "password";
  e.currentTarget.textContent = show ? "Hide" : "Show";
});
document.getElementById("forgetBtn").addEventListener("click", () => {
  draft.keys[draft.provider] = "";
  f.key.value = "";
});
document.getElementById("clearFilesBtn").addEventListener("click", () => {
  for (const p of files.paths()) files.remove(p);
  renderSettingsFiles();
  renderAll();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  updateSubtitle();
  const current = await loadStorage();
  openChat(current, false);
  updateSendState();
})();
