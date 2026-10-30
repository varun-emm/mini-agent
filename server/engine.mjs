// Mini Agent server engine: the same agent as the browser app (loop, tools, helpers, debate, memory,
// summarising), running on a server. Most of this file is copied verbatim from app.js by
// tools/build-engine.py; server-specific pieces (files, Python, screenshots, page reading, job state) are below.
import { AsyncLocalStorage } from "node:async_hooks";
import { runPython, thumbnail, fileShot, webShot, htmlToText, isPrivateHost } from "./sandbox.mjs";
const OR_BASE = (process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

// Every job runs with its own state (settings, conversation, files), so several chats can work at once.
export const jobStore = new AsyncLocalStorage();
const state = new Proxy({}, {
  get: (_, k) => (jobStore.getStore() || {})[k],
  set: (_, k, v) => { jobStore.getStore()[k] = v; return true; },
});
const files = new Proxy({}, { get: (_, k) => { const f = state.files; const v = f[k]; return typeof v === "function" ? v.bind(f) : v; } });

const provider = () => PROVIDERS.openrouter;
const apiKey = () => process.env.OPENROUTER_API_KEY || "";
const mainModel = () => state.settings.models.openrouter || provider().defaultModel;
const currentModel = () => state.speaker || mainModel();
const visionModel = () => state.settings.visionModels.openrouter || provider().visionModel;
const reviewModel = () => state.settings.reviewModel || "anthropic/claude-sonnet-5.5";
const debateReady = () => state.settings.debate && !!apiKey();
const enc = new TextEncoder();
const dec = new TextDecoder();
const approveCode = (code) => (state.settings.askBeforeCode ? state.ask("code", code) : Promise.resolve(true));

// Memory: the phone sends its saved notes with each job; changes come back in the result.
const memory = {
  get items() { return state.memory; },
  add(text) {
    text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!text) throw new Error("fact is required");
    if (state.memory.some((m) => m.text.toLowerCase() === text.toLowerCase())) return false;
    state.memory.push({ id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, at: Date.now() });
    while (state.memory.length > 60) state.memory.shift();
    return true;
  },
  forget(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    const words = q.split(/\W+/).filter((w) => w.length > 2);
    const hit = (t) => { t = t.toLowerCase(); return t.includes(q) || q.includes(t) || (words.length && words.filter((w) => t.includes(w)).length >= Math.ceil(words.length * 0.6)); };
    const gone = state.memory.filter((m) => hit(m.text));
    state.memory = state.memory.filter((m) => !gone.includes(m));
    return gone.map((m) => m.text);
  },
};

// Reading a web page: the server can fetch pages directly (no browser restrictions).
//   1. fetch the page and turn its HTML into text
//   2. Jina Reader, for pages that need a real browser or block simple fetches
//   3. if both fail, a search model visits the page and reports what's on it
const PAGE_CHUNK = 8000;
const pageCache = new Map();
async function readPage(url, signal) {
  if (pageCache.has(url)) return pageCache.get(url);
  let host = "";
  try { host = new URL(url).hostname; } catch (_) { return null; }
  if (isPrivateHost(host)) return null;
  const tries = [
    ["the server", url, (t, type) => (/html|xml/i.test(type) ? htmlToText(t) : t)],
    ["Jina Reader", `https://r.jina.ai/${url}`, (t) => t],
  ];
  for (const [how, u, toText] of tries) {
    try {
      const res = await fetch(u, { signal: AbortSignal.any([signal, AbortSignal.timeout(25000)].filter(Boolean)), redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MiniAgent/4; +https://github.com/varun-emm/mini-agent)", Accept: "text/html,text/plain,*/*;q=0.5" } });
      if (!res.ok) continue;
      const text = toText(await res.text(), res.headers.get("content-type") || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 200) continue;          // an empty shell: the page needs a real browser
      const page = { text, how };
      pageCache.set(url, page);
      if (pageCache.size > 50) pageCache.delete(pageCache.keys().next().value);
      return page;
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }
  }
  return null;
}

const PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    url: OR_BASE + "/chat/completions",
    keyPrefix: "sk-or-",
    keyLink: "https://openrouter.ai/settings/keys",
    defaultModel: "moonshotai/kimi-k3.1-pro",
    searchModel: "openai/gpt-oss-120b",         // cheap model + OpenRouter's "web" plugin
    visionModel: "anthropic/claude-haiku-5.5",
    visionModels: [["anthropic/claude-haiku-5.5", "Sharp at reading documents"], ["moonshotai/kimi-k3.1-pro", "Kimi reads images too"], ["openai/gpt-6-luna", "Fast and cheap"]],
    models: [["moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro: strongest at long jobs"], ["anthropic/claude-sonnet-5.5", "Claude: careful and clear"], ["openai/gpt-oss-120b", "Cheapest, about 10x less"]],
  },
};
// Short, friendly names for models, used when two of them debate
const MODEL_NAMES = { "moonshotai/kimi-k3.1-pro": "Kimi", "anthropic/claude-sonnet-5.5": "Claude", "anthropic/claude-haiku-5.5": "Claude Haiku", "openai/gpt-oss-120b": "GPT-OSS" };
const modelName = (id) => MODEL_NAMES[id] || String(id || "").split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const MAX_STEPS = 60;              // steps per request before it stops and asks to continue
const HELPER_STEPS = 25;           // steps a helper agent may take
const MAX_TOOL_OUTPUT = 6000;
// When the conversation the model sees grows past this many characters, old tool output is shortened
// and older turns are summarised by the model (instead of being forgotten).
const CONTEXT_CHARS = Number(process.env.CONTEXT_CHARS) || 70000;


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
  mp4: ["video", "MP4 video", "video/mp4"],
  mov: ["video", "QuickTime video", "video/quicktime"],
  webm: ["video", "WebM video", "video/webm"],
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

class AgentError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function endpoint() { return PROVIDERS.openrouter.url; }

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
    throw new AgentError("Couldn't reach OpenRouter. Check your internet connection and try again.", "network");
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
      "Free models (ending in :free) have tight limits; paid models rarely hit this.", "rate");
  }
  if (status === 404 && /model/i.test(e.message || "")) {
    return new AgentError(`${name} doesn't recognise the model "${model}", or it can't use tools. Pick another model in Settings.`, "model");
  }
  return new AgentError(`${name} returned an error (${status}): ${e.message || "unknown error"}`, code || "http");
}

// Rate limits: wait as long as the provider asks (up to ~45s, a few times), then try again by itself.
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
    if (state.rateNotice) state.rateNotice(wait, attempt + 1);
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
  {
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


const OR_API = OR_BASE;
const IMAGE_MODELS = [["google/gemini-3.1-flash-image", "Quick and cheap, good at edits"], ["openai/gpt-image-2", "Best at text inside images"], ["black-forest-labs/flux-3-image", "Photorealistic"]];
const VIDEO_MODELS = [["google/veo-3.1-fast", "Good quality with sound, fair price"], ["google/veo-3.1", "Best quality, costs about 4x more"], ["kwaivgi/kling-v3.0-std", "Smooth motion, low price"], ["alibaba/wan-3.0", "Budget, clips up to 30 seconds"]];
const orKey = () => apiKey();
async function orFetch(path, { method = "GET", body, signal, raw = false } = {}) {
  let res;
  try {
    res = await fetch(OR_API + path, {
      method, signal,
      headers: { Authorization: "Bearer " + orKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Couldn't reach OpenRouter. Check the internet connection.");
  }
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok || (data && data.error && !data.status)) {
    const msg = (data && data.error && (data.error.message || data.error)) || `error ${res.status}`;
    if (res.status === 401) throw new Error("OpenRouter rejected the key. Check it in Settings.");
    if (res.status === 402) throw new Error("The OpenRouter account doesn't have enough credit (image and video models need more than $1 of credit).");
    throw Object.assign(new Error(`OpenRouter: ${msg}`), { status: res.status });
  }
  return data;
}
const b64ToBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const MEDIA_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
function mediaName(wanted, prompt, ext) {
  let base = String(wanted || "").split("/").pop().replace(/\.[a-z0-9]+$/i, "");
  if (!base) base = String(prompt || "image").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 4).join("-") || "image";
  base = base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
  let name = `${base}.${ext}`;
  for (let i = 2; files.has(name); i++) name = `${base}-${i}.${ext}`;
  return name;
}
// An attached or earlier image, as a data URL no bigger than 1536px (what image models accept comfortably).
async function imageRef(path) {
  const p = cleanPath(path);
  if (!files.has(p)) throw new Error(`No file called ${p}. Use list_files to see what exists.`);
  if (fileInfo(p).kind !== "image") throw new Error(`${p} isn't an image.`);
  return thumbnail(files.abs(p), 1536, fileInfo(p).ext === "png" ? "png" : "jpeg");
}
const money = (usd) => (usd >= 0.995 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3).replace(/0$/, "")}` : `under 1 cent`);

async function makeImage({ prompt, aspect_ratio, edit, filename }, ctx) {
  if (!prompt) throw new Error("prompt is required: describe the picture in detail");
  const model = state.settings.imageModel || IMAGE_MODELS[0][0];
  const refs = [];
  for (const p of [].concat(edit || []).slice(0, 4)) refs.push({ type: "image_url", image_url: { url: await imageRef(p) } });
  const body = { model, prompt, n: 1, output_format: "png" };
  if (aspect_ratio) body.aspect_ratio = aspect_ratio;
  if (refs.length) body.input_references = refs;
  let bytes, mime = "image/png", cost = null;
  try {
    const data = await orFetch("/images", { method: "POST", body, signal: ctx.signal });
    const d = data.data && data.data[0];
    if (!d || !d.b64_json) throw new Error("OpenRouter sent back no image.");
    bytes = b64ToBytes(d.b64_json); mime = d.media_type || mime;
    cost = data.usage && data.usage.cost;
  } catch (e) {
    if (e.name === "AbortError" || ![400, 404, 405].includes(e.status)) throw e;
    // some image models only work through chat: ask for an image in the reply instead
    const content = refs.length ? [{ type: "text", text: prompt }, ...refs] : prompt;
    const data = await orFetch("/chat/completions", { method: "POST", signal: ctx.signal, body: {
      model, modalities: ["image", "text"], messages: [{ role: "user", content }], ...(aspect_ratio ? { image_config: { aspect_ratio } } : {}),
    } });
    const m = data.choices && data.choices[0] && data.choices[0].message;
    const url = m && m.images && m.images[0] && m.images[0].image_url && m.images[0].image_url.url;
    const hit = url && url.match(/^data:([^;]+);base64,(.+)$/);
    if (!hit) throw new Error(`${model} didn't return an image${m && m.content ? `. It said: ${String(m.content).slice(0, 200)}` : "."}`);
    mime = hit[1]; bytes = b64ToBytes(hit[2]);
    cost = data.usage && data.usage.cost;
  }
  const name = mediaName(filename, prompt, MEDIA_EXT[mime] || "png");
  files.put(name, bytes);
  if (ctx.onImage) { try { ctx.onImage(await thumbnail(files.abs(name), 1100, "jpeg")); } catch (_) { /* preview only */ } }
  return `Saved ${name} (${humanSize(bytes.length)}, made with ${model}${typeof cost === "number" ? `, cost ${money(cost)}` : ""}). It's shown to the user automatically. ` +
    `If details or text in it matter, check it with screenshot.`;
}

// Video: estimate the price, ask the user, start the job, wait for it, then download the clip.
let videoModelsCache = null;
async function videoModelInfo(model, signal) {
  if (!videoModelsCache) {
    try { videoModelsCache = (await orFetch("/videos/models", { signal })).data || []; } catch (e) { if (e.name === "AbortError") throw e; videoModelsCache = []; }
  }
  return videoModelsCache.find((m) => m.id === model || m.canonical_slug === model) || null;
}
function pickClosest(list, wanted, fallback) {
  if (list && !Array.isArray(list) && typeof list === "object" && "min" in list) {   // a range like { min: 2, max: 30 }
    const w = wanted ?? fallback;
    return Math.max(list.min, Math.min(list.max ?? list.min, w));
  }
  if (!Array.isArray(list) || !list.length) return wanted ?? fallback;
  if ((wanted == null || wanted === "") && list.includes(fallback)) return fallback;
  if (wanted == null || wanted === "") return list[0];
  if (list.includes(wanted)) return wanted;
  if (typeof wanted === "number") return list.reduce((a, b) => (Math.abs(b - wanted) < Math.abs(a - wanted) ? b : a));
  return list[0];
}
// The price list has per-second prices that can differ by resolution and by whether there's sound.
// Returns { low, high } for the clip (the same when there's one price), or null if there's no per-second price.
function priceFor(info, seconds, resolution) {
  const sk = (info && info.pricing_skus) || {};
  const rows = Object.entries(sk).filter(([k]) => /second/i.test(k))
    .map(([k, v]) => [k.toLowerCase(), Number(v) / (/cent/i.test(k) ? 100 : 1)]).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!rows.length) return null;
  const res = String(resolution || "").toLowerCase();
  const mentionsRes = (k) => /\d{3,4}p|\dk\b/.test(k);
  let pick = rows.filter(([k]) => res && k.includes(res));
  if (!pick.length) pick = rows.filter(([k]) => !mentionsRes(k));
  if (!pick.length) pick = rows;
  const vals = pick.map(([, v]) => v * seconds);
  return { low: Math.min(...vals), high: Math.max(...vals) };
}
const confirmVideo = (text) => state.ask("video", text);
async function makeVideo({ prompt, seconds, aspect_ratio, resolution, from_image, filename }, ctx) {
  if (!prompt) throw new Error("prompt is required: describe the scene, the camera movement and the mood");
  const model = state.settings.videoModel || VIDEO_MODELS[0][0];
  const info = await videoModelInfo(model, ctx.signal);
  const dur = pickClosest(info && info.supported_durations, seconds ? Math.round(Number(seconds)) : null, 6);
  const res = pickClosest(info && info.supported_resolutions, resolution || "720p", "720p");
  const ratio = pickClosest(info && info.supported_aspect_ratios, aspect_ratio || "16:9", "16:9");
  const est = priceFor(info, dur, res);
  const ok = await confirmVideo(`${dur}-second ${res} video (${ratio}) with ${model.split("/").pop()}. ` +
    (est ? `It will cost about ${est.high - est.low < 0.01 ? money(est.low) : `${money(est.low)} to ${money(est.high)} (more with sound)`} of OpenRouter credit.`
      : "OpenRouter didn't list a per-second price for this model; video models usually cost $0.03 to $0.40 per second.") +
    `\n\n“${String(prompt).slice(0, 240)}${String(prompt).length > 240 ? "…" : ""}”`);
  if (!ok) return "The user chose not to make this video (it costs money). Ask if they'd like a shorter clip, a different model, or still images instead.";
  const body = { model, prompt, duration: dur, resolution: res, aspect_ratio: ratio };
  if (from_image) body.input_references = [{ type: "image_url", image_url: { url: await imageRef(from_image) } }];
  const job = await orFetch("/videos", { method: "POST", body, signal: ctx.signal });
  if (!job || !job.id) throw new Error("OpenRouter didn't start the video job.");
  const started = Date.now();
  let st = job;
  while (!["completed", "failed", "cancelled", "expired"].includes(st.status)) {
    if (Date.now() - started > 15 * 60 * 1000) throw new Error(`The video is still not ready after 15 minutes (job ${job.id}).`);
    await waitFor(5000, ctx.signal);
    const secs = Math.round((Date.now() - started) / 1000);
    if (ctx.onProgress) ctx.onProgress(`Making the video (${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`} so far, usually 1 to 3 minutes)`);
    try { st = await orFetch(`/videos/${job.id}`, { signal: ctx.signal }); } catch (e) { if (e.name === "AbortError") throw e; }
  }
  if (st.status !== "completed") throw new Error(`The video ${st.status}${st.error ? `: ${typeof st.error === "string" ? st.error : st.error.message || ""}` : ""}.`);
  if (ctx.onProgress) ctx.onProgress("Downloading the video");
  let bytes = null, mime = "video/mp4";
  const tries = [[`/videos/${job.id}/content?index=0`, true], ...((st.urls || []).map((u) => [u, false]))];
  for (const [u, auth] of tries) {
    try {
      const r = auth ? await orFetch(u, { signal: ctx.signal, raw: true }) : await fetch(u, { signal: ctx.signal });
      if (!r.ok) continue;
      const blob = await r.blob();
      if (blob.size < 1000) continue;
      bytes = new Uint8Array(await blob.arrayBuffer()); mime = (blob.type || "").startsWith("video/") ? blob.type : mime;
      break;
    } catch (e) { if (ctx.signal && ctx.signal.aborted) throw e; }
  }
  const cost = st.usage && typeof st.usage.cost === "number" ? `, cost ${money(st.usage.cost)}` : "";
  if (!bytes) {
    const link = (st.urls || [])[0];
    return `The video was made${cost}, but this browser couldn't download it.` + (link ? ` Give the user this link to open or save it (it works for a limited time; anyone with it can download the video): ${link}` : ` Its job id is ${job.id}.`);
  }
  const name = mediaName(filename, prompt, MEDIA_EXT[mime] || "mp4");
  files.put(name, bytes);
  return `Saved ${name} (${dur}s, ${res}, ${humanSize(bytes.length)}, made with ${model}${cost}). It's shown to the user automatically and plays in the chat.`;
}


// A helper agent: works on one self-contained task with its own conversation, in parallel with others.
function helperPrompt() {
  return systemPrompt().replace(/^You are Mini Agent[^\n]*/, "You are a helper agent inside Mini Agent. A lead agent gave you one self-contained task; other helpers may be working on other parts at the same time. Do the task completely with your tools, then reply with a clear, factual report for the lead agent (not for the user): the findings with numbers, dates and source URLs, and the names of any files you made.")
    .replace(/\nPlanning:[\s\S]*?(?=\n\n)/, "").replace(/\nHelpers and parallel work:[\s\S]*?(?=\n\n)/, "").replace(/\nMemory:[\s\S]*?(?=\n\n)/, "");
}

const TOOL_FUNCTIONS = {
  async web_search({ query }, ctx) {
    if (!query) throw new Error("query is required");
    return askWeb(`Search the web and answer concisely and factually. Include specific numbers and dates, and list the source URLs you used.\n\nQuery: ${query}`, ctx.signal);
  },
  async fetch_webpage({ url, start }, ctx) {
    let host = "";
    try { host = new URL(url).hostname; } catch (_) { /* invalid */ }
    if (!/^https?:\/\//i.test(url || "") || !host) throw new Error("Give a full URL starting with http:// or https://");
    const page = await readPage(url, ctx.signal);
    if (!page) {
      const summary = await askWeb(`Visit this exact page and report its main content in detail: key facts, numbers, names and dates. Don't add anything that isn't on the page.\n\nURL: ${url}`, ctx.signal, host);
      return summary + "\n\n(The page couldn't be loaded directly, so this is a search model's report of it, not the exact text.)";
    }
    const total = page.text.length;
    const from = Math.max(0, Math.min(Number(start) || 0, total));
    const part = page.text.slice(from, from + PAGE_CHUNK);
    const to = from + part.length;
    let head = `Text of ${url} (read with ${page.how})`;
    if (from > 0 || to < total) head += `, characters ${from}-${to} of ${total}`;
    head += to < total ? `. More follows: call fetch_webpage with start=${to} to read on.` : ".";
    return `${head}\n\n${part}`;
  },
  async calculator({ expression }) { return calculate(expression); },
  async run_python({ code }, ctx) {
    if (!code) throw new Error("code is required");
    if (!(await approveCode(code))) return "The user declined to run this code. Ask them, or try another approach.";
    const before = files.snapshot();
    const r = await runPython(code, files.dir, ctx.signal, ctx.onProgress);
    if (!r.ok) return "Error: " + r.error;
    const after = files.snapshot();
    const changed = [...after.keys()].filter((p) => before.get(p) !== after.get(p));
    const removed = [...before.keys()].filter((p) => !after.has(p));
    let out = `exit code: ${r.exit}\nstdout:\n${r.out}\nstderr:\n${r.err}`;
    if (changed.length) out += `\nFiles created or updated (shown to the user automatically): ${changed.map((p) => `${p} (${humanSize(files.get(p).size)})`).join(", ")}`;
    if (removed.length) out += `\nFiles deleted: ${removed.join(", ")}`;
    return out;
  },
  async write_file({ path, content }) {
    const p = cleanPath(path);
    files.put(p, enc.encode(String(content ?? "")));
    return `Wrote ${humanSize(files.get(p).size)} to ${p}. It is shown to the user automatically.`;
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
    return names.length ? names.map((n) => `${n} (${humanSize(files.get(n).size)})`).join("\n") : "(no files yet)";
  },
  async screenshot({ target, question, page }, ctx) {
    const t = String(target || "").trim();
    if (!t) throw new Error("target is required: the name of a file you made, or a web page URL");
    let shot, label;
    if (/^https?:\/\//i.test(t)) {
      shot = await webShot(t, ctx.signal);
      label = `the web page ${t}`;
    } else {
      const p = cleanPath(t);
      if (!files.has(p)) throw new Error(`No file called ${p}. Use list_files to see what exists.`);
      try { shot = await fileShot(files, p, page); } catch (e) { throw new Error(`Couldn't screenshot ${p}: ${e.message}`); }
      label = `the file ${p}` + (shot.note ? ` (${shot.note})` : "");
    }
    if (ctx.onImage) ctx.onImage(shot.src);
    if (ctx.onProgress) ctx.onProgress(`Looking closely at ${t.length > 50 ? hostOf(t) : t}`);
    const seen = await lookAt(shot, question, label, ctx.signal);
    const size = shot.width ? `${shot.width}×${shot.height}px${shot.cropped ? ", cut off at the bottom because the page is very long" : ""}` : "full page";
    return `Screenshot of ${label} (${size}).\nWhat the vision model (${visionModel()}) saw:\n${seen}`;
  },
  async update_plan({ steps }, ctx) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("steps must be a list like [{\"text\": \"Search for rates\", \"status\": \"active\"}]");
    const ok = new Set(["pending", "active", "done", "skipped"]);
    const plan = steps.slice(0, 12).map((x) => (typeof x === "string" ? { text: x, status: "pending" } : x))
      .map((x) => ({ text: String(x.text || x.step || "").trim().slice(0, 120), status: ok.has(x.status) ? x.status : x.status === "in_progress" ? "active" : x.status === "completed" ? "done" : "pending" }))
      .filter((x) => x.text);
    if (ctx.view && ctx.view.plan) ctx.view.plan(plan);
    const done = plan.filter((x) => x.status === "done").length;
    return `Plan updated: ${done} of ${plan.length} steps done. Keep it current as you work.`;
  },
  async remember({ fact }) {
    if (!state.settings.memory) return "Memory is turned off in Settings, so nothing was saved.";
    return memory.add(fact) ? `Saved to memory: ${String(fact).trim()}` : "Already in memory.";
  },
  async forget({ fact }) {
    const gone = memory.forget(fact);
    return gone.length ? `Removed from memory: ${gone.join("; ")}` : "Nothing in memory matched that.";
  },
  async delegate({ task }, ctx) {
    if (!task || String(task).trim().length < 10) throw new Error("task is required: a complete, self-contained description of the work");
    if (!ctx.spawn) throw new Error("Helpers can't start their own helpers. Do this part yourself.");
    return ctx.spawn(String(task).trim(), ctx.signal);
  },
  async generate_image(args, ctx) {
    if (!orKey()) return "Error: making pictures needs an OpenRouter key. Tell the user to add one in Settings.";
    return makeImage(args, ctx);
  },
  async generate_video(args, ctx) {
    if (!orKey()) return "Error: making videos needs an OpenRouter key. Tell the user to add one in Settings.";
    return makeVideo(args, ctx);
  },
  async get_current_time() {
    return new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: state.tz }) + ` (${state.tz})`;
  },
};

const tool = (name, description, properties = {}, required = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

const TOOLS = [
  tool("web_search", "Search the web. Use for anything current, factual, or that you are unsure about.",
    { query: { type: "string" } }, ["query"]),
  tool("fetch_webpage", "Read the actual text of a web page by URL. Use after web_search when you need the exact details of one page. " +
    "Long pages come in parts of about 8,000 characters: the result says which start= to pass to read on.",
    { url: { type: "string" }, start: { type: "integer", description: "Character to start from, for long pages (default 0)" } }, ["url"]),
  tool("calculator", "Exact arithmetic, e.g. '125000 * 0.18' or 'round(sqrt(2), 3)'. Use instead of doing maths in your head.",
    { expression: { type: "string" } }, ["expression"]),
  tool("run_python", "Run Python 3 on the server (it has internet access, and requests is installed). Use it for calculations, data work, and to CREATE FILES: " +
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
  tool("update_plan", "Show the user your plan for a multi-step job as a live checklist. Call it before starting a job of 3 or more steps, " +
    "then again whenever a step starts (status active) or finishes (done), or the plan changes. Send the whole list every time.",
    { steps: { type: "array", items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done", "skipped"] } }, required: ["text", "status"] } } }, ["steps"]),
  tool("delegate", "Hand one self-contained part of a bigger job to a helper agent. Call it several times in ONE reply and the helpers work at the same time. " +
    "The helper can search, read pages, calculate, run Python and make files, but can't see this conversation: put everything it needs in task " +
    "(what to find or make, file names, format, numbers to use). It replies with a report. Use only for independent parts that each take several steps.",
    { task: { type: "string" } }, ["task"]),
  tool("remember", "Save one short, lasting fact the user told you about themselves (name, business, city, preferences for how you work) " +
    "so you know it in future chats. Never save passwords, keys, card, bank or ID numbers, or health details.",
    { fact: { type: "string" } }, ["fact"]),
  tool("forget", "Remove something from memory when the user asks you to forget it.", { fact: { type: "string" } }, ["fact"]),
  tool("generate_image", "Make a picture with an AI image model: photos, illustrations, logos, posters, product shots, social posts. " +
    "Write a detailed prompt (subject, style, composition, lighting, colours, any exact text to show). To edit or restyle images in the workspace " +
    "(attached or made earlier), list them in edit and describe the change. Not for charts or diagrams of data: use run_python for those.",
    { prompt: { type: "string" }, aspect_ratio: { type: "string", description: "e.g. 1:1, 16:9, 9:16, 4:5" },
      edit: { type: "array", items: { type: "string" }, description: "Image files to edit or use as reference" },
      filename: { type: "string", description: "Short name for the file, without extension" } }, ["prompt"]),
  tool("generate_video", "Make a short video clip with an AI video model. It costs real money (about $0.03 to $0.40 per second), takes 1 to 3 minutes, " +
    "and the user is asked to confirm the price first. Use it only when the user asks for a video. Describe the scene, action, camera movement and mood. " +
    "from_image animates an image in the workspace.",
    { prompt: { type: "string" }, seconds: { type: "integer", description: "Length; the model's nearest supported length is used" },
      aspect_ratio: { type: "string", description: "16:9, 9:16 or 1:1" }, resolution: { type: "string", description: "720p (default) or 1080p" },
      from_image: { type: "string" }, filename: { type: "string" } }, ["prompt"]),
];
// Who gets which tools
const MEMORY_TOOLS = new Set(["remember", "forget"]);
const MEDIA_TOOLS = new Set(["generate_image", "generate_video"]);
const leadTools = () => TOOLS.filter((t) => (state.settings.memory || !MEMORY_TOOLS.has(t.function.name)) && (orKey() || !MEDIA_TOOLS.has(t.function.name)));
const helperTools = () => TOOLS.filter((t) => !["delegate", "update_plan", "remember", "forget", "generate_video"].includes(t.function.name) && (orKey() || !MEDIA_TOOLS.has(t.function.name)));
// lookups that can safely run at the same time (they don't change files)
const PARALLEL_SAFE = new Set(["web_search", "fetch_webpage", "calculator", "read_file", "list_files", "get_current_time", "delegate", "generate_image"]);

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
    return truncate(await fn(args, ctx), name === "fetch_webpage" ? PAGE_CHUNK + 800 : name === "delegate" ? 9000 : MAX_TOOL_OUTPUT);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return `Error while running ${name}: ${e.message}`;
  }
}


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
    case "fetch_webpage": return `${done ? "Read" : "Reading"} ${hostOf(a.url)}${a.start ? " (continued)" : ""}`;
    case "update_plan": return done ? "Updated the plan" : "Updating the plan";
    case "remember": return done ? `Remembered ${quote(a.fact, 70)}` : "Saving to memory";
    case "forget": return done ? `Forgot ${quote(a.fact, 70)}` : "Removing from memory";
    case "generate_image": return done ? `${a.edit && [].concat(a.edit).length ? "Edited" : "Made"} an image: ${quote(a.prompt, 60)}` : `${a.edit && [].concat(a.edit).length ? "Editing" : "Making"} an image: ${quote(a.prompt, 50)}`;
    case "generate_video": return done ? `Made a video: ${quote(a.prompt, 60)}` : `Getting ready to make a video: ${quote(a.prompt, 45)}`;
    case "delegate": return done ? `A helper finished ${quote(a.task, 70)}` : `Handing ${quote(a.task, 60)} to a helper`;
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
    case "update_plan": return "Writing a plan";
    case "generate_image": { const t = partialField(raw, "prompt"); return t ? `Describing the picture: ${quote(t, 55)}` : "Describing a picture"; }
    case "generate_video": { const t = partialField(raw, "prompt"); return t ? `Describing the video: ${quote(t, 55)}` : "Describing a video"; }
    case "delegate": { const t = partialField(raw, "task"); return t ? `Briefing a helper: ${quote(t, 60)}` : "Briefing a helper"; }
    case "remember": return "Noting something to remember";
    default: return `Preparing ${name.replace(/_/g, " ")}`;
  }
}

// Which way the loader turns: tools that pull information in run it backwards; tools that make things run it forwards.
const PULL_TOOLS = new Set(["web_search", "fetch_webpage", "read_file", "list_files", "get_current_time", "screenshot"]);

function stepDetail(name, args, result) {
  if (name === "screenshot") return `Asked: ${args.question || "(no question)"}\n\n${result}`;
  if (name === "run_python") return `${args.code || ""}\n\n— Output —\n${result}`;
  if (name === "calculator") return `${args.expression} = ${result}`;
  if (name === "generate_image" || name === "generate_video") return `Prompt: ${args.prompt || ""}\n\n${result}`;
  if (name === "delegate") return `Task: ${args.task || ""}\n\n— Report —\n${result}`;
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
function memorySection() {
  if (!state.settings.memory) return "";
  const facts = memory.items.map((m) => `- ${m.text}`).join("\n");
  return `
Memory:
- When the user tells you something lasting about themselves (name, business, city, how they like answers), save it with remember in one short line, in their words. Don't save one-off task details. Never save passwords, keys, card, bank or ID numbers, or health details.
- If they ask you to forget something, use forget. If they ask what you remember, list it.
${facts ? `- What you already know about the user from earlier chats:\n${facts}` : "- You don't know anything about the user yet."}
`;
}

function systemPrompt() {
  const now = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: state.tz });
  return `You are Mini Agent, a capable assistant that completes tasks by working in a loop: think about the next step, use a tool, look at the result, and repeat until the task is truly done.

Current date and time: ${now} (${state.tz}).

How to work:
- For anything about the present (prices, news, rates, who holds a role, latest versions), use web_search first. Do not rely on memory.
- For any number that matters, use calculator or run_python. Never do important maths in your head.
- If a tool returns an error, read it, fix your approach, and try again. Don't repeat the exact same failing call.
- Ask the user a question only when you truly cannot proceed without their input.
- You can take up to ${MAX_STEPS} steps per request, so finish big jobs properly. In long jobs, older tool output may be shortened and older messages summarised to save space; re-read a file or page if you need its details again.

Planning:
- For any job with 3 or more steps, call update_plan first with a short plan (3 to 8 steps, plain words). Mark each step active when you start it and done when it's finished, and change the plan if you learn something new. The user watches this checklist.
- Skip the plan for simple questions and quick lookups.

Helpers and parallel work:
- When you need several independent lookups, ask for all of them in one reply (for example three web_search calls at once). They run at the same time.
- For a big job with independent parts (researching several companies, making separate files), call delegate once per part in the same reply, so helper agents work on them at the same time. Give each one a complete, self-contained task. Then combine their reports yourself and check the result.
- Don't delegate small or sequential steps; do those yourself.

Pictures and video:
${orKey() ? `- generate_image makes pictures with an AI model (photos, illustrations, logos, posters, social posts) and can edit or restyle images in the workspace. Write detailed prompts. For charts of data use run_python instead.
- generate_video makes short clips, but each one costs real money and the user must confirm the price. Use it only when they ask for a video.
- After making an image whose details or text matter, check it with screenshot, and make it again if it's wrong.` : `- Making AI pictures and videos needs an OpenRouter key. If the user asks for one, tell them to add an OpenRouter key in Settings. You can still draw charts and diagrams with run_python.`}

Files the user attaches:
- They're in your workspace under their own names (list_files shows them). Open them with run_python: pypdf for PDFs, python-docx for Word, openpyxl or pandas for Excel and CSV, python-pptx for PowerPoint.
- To see an image, a photo or a scanned page, use screenshot on the file with a specific question. Use page= for a PDF page.
${memorySection()}
Making files (the user can preview, download and share them):
- You can make real files: Excel (.xlsx), Word (.docx), PDF, PowerPoint (.pptx), charts and images (.png), CSV, Markdown, HTML, JSON, code and ZIP.
- Build binary files with run_python and save them in the current folder with short, descriptive names (e.g. "gst_summary.xlsx"). Text files can also use write_file.
- Libraries: openpyxl or pandas for Excel (use real formulas, bold headers, sensible column widths, number formats); python-docx for Word; python-pptx for PowerPoint; fpdf2 for PDF; matplotlib for charts (plt.savefig("name.png", dpi=200, bbox_inches="tight")). They install automatically the first time.
- For fpdf2 PDFs, use the provided Unicode font so symbols like ₹ work: pdf.add_font("DejaVu", "", FONT_REGULAR); pdf.add_font("DejaVu", "B", FONT_BOLD); pdf.set_font("DejaVu", size=11). FONT_REGULAR and FONT_BOLD are already defined in your Python.
- Python runs on a server with internet access, so it can download a data file directly with requests. Still use web_search and fetch_webpage to find and read information.
- After making a file, check it (reopen it in Python and print a short summary) before finishing.
- fetch_webpage gives the page's real text. Read the parts you need instead of guessing from search snippets.
- Files appear to the user automatically, so don't paste their contents into your answer. Name each file and say in a line what's in it.
- The user is usually on a phone. HTML files (games, pages, tools) open and run right inside this app when the user taps the file card, so say "tap the file to open it", not "double-click" or "drag into a browser". Make HTML pages work with touch and fit a phone screen.

Checking your work with screenshots:
- You have a screenshot tool. After you make a chart, PDF, Word, Excel, CSV or HTML file, take a screenshot of it and ask a specific question (is the title right, are labels readable, do the totals match, is anything cut off or empty).
- If the screenshot shows a problem, fix the file and check it again. Say briefly in your answer what you checked.
- To see what a web page looks like, screenshot its URL. The server is slow, so use it only when looking matters.
- Don't take screenshots of plain text answers, and don't take more than you need.

When finished, give a clear, concise final answer in Markdown. Briefly say what you checked, and list source URLs if you used the web.`;
}

const SHORT_MARK = "\n…(older output shortened to save space)";
const SUMMARY_MARK = "[Summary of the earlier part of this chat, written to save space]\n";
const msgSize = (msgs) => msgs.reduce((n, m) => n + JSON.stringify(m).length, 0);
const isRealUser = (m) => m.role === "user" && typeof m.content === "string" && !/^\[(harness note|Debate)/.test(m.content);

// Every tool call needs an answer before the model is asked again. If a request was stopped part-way,
// fill the gaps (and drop stray answers), so the next message doesn't fail.
function repairToolPairs(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") {
      const owner = msgs.slice(0, i).reverse().find((x) => x.role !== "tool");
      if (!owner || !owner.tool_calls || !owner.tool_calls.some((tc) => tc.id === m.tool_call_id)) { msgs.splice(i, 1); i--; }
      continue;
    }
    if (m.role !== "assistant" || !m.tool_calls || !m.tool_calls.length) continue;
    let j = i + 1;
    const answered = new Set();
    while (j < msgs.length && msgs[j].role === "tool") answered.add(msgs[j++].tool_call_id);
    const missing = m.tool_calls.filter((tc) => !answered.has(tc.id))
      .map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "(Not run: the request was stopped before this finished.)" }));
    if (missing.length) msgs.splice(j, 0, ...missing);
  }
}

async function summarise(old, signal) {
  const lines = [];
  for (const m of old) {
    if (m.role === "user") lines.push(`USER: ${truncate(m.content || "", 3000)}`);
    else if (m.role === "assistant") {
      if (m.content) lines.push(`ASSISTANT: ${truncate(m.content, 3000)}`);
      for (const tc of m.tool_calls || []) lines.push(`  (used ${tc.function.name}: ${truncate(tc.function.arguments || "", 300)})`);
    } else if (m.role === "tool") lines.push(`  (result: ${truncate(m.content || "", 500)})`);
  }
  const data = await callLLM({
    model: currentModel(),
    messages: [
      { role: "system", content: "You compress a chat between a user and an AI agent so the agent can keep working without the full history. Write a compact summary in plain text: what the user asked for and their preferences, decisions made, key facts and numbers found (with sources), files made (exact names and contents in brief), and anything left unfinished. Keep exact numbers, names and file names. Under 400 words." },
      { role: "user", content: truncate(lines.join("\n"), 40000) },
    ],
    temperature: 0.2, max_tokens: 3000,
  }, signal);
  return String(data.choices[0].message.content || "").trim();
}

// Keep what the model sees within CONTEXT_CHARS: first shorten old tool output, then summarise older turns.
async function compactContext(msgs, view, signal) {
  repairToolPairs(msgs);
  if (msgSize(msgs) <= CONTEXT_CHARS) return;
  for (let i = 0; i < msgs.length - 8; i++) {
    const m = msgs[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500 && !m.content.endsWith(SHORT_MARK)) {
      m.content = m.content.slice(0, 1200) + SHORT_MARK;
    }
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if ((tc.function.arguments || "").length <= 2500) continue;
        const a = parseArgs(tc.function.arguments);
        for (const k of Object.keys(a)) if (typeof a[k] === "string" && a[k].length > 1500) a[k] = a[k].slice(0, 1200) + "\n# …(shortened to save space)";
        tc.function.arguments = JSON.stringify(a);
      }
    }
  }
  if (msgSize(msgs) <= CONTEXT_CHARS) return;
  const turns = msgs.map((m, i) => (isRealUser(m) ? i : -1)).filter((i) => i >= 0);
  if (turns.length < 3) return;                 // only the current and previous request: nothing old enough
  const cut = turns[turns.length - 2];          // keep the previous request and this one in full
  view.progress("Summarising the earlier conversation to make room");
  let summary = "";
  try { summary = await summarise(msgs.slice(0, cut), signal); } catch (e) { if (e.name === "AbortError") throw e; }
  msgs.splice(0, cut, ...(summary ? [{ role: "user", content: SUMMARY_MARK + summary }] : []));
  view.addStep(summary ? { icon: "note", label: "Summarised the earlier conversation to make room", detail: summary }
    : { icon: "note", label: "Set aside the oldest messages to make room" });
}

// ---------------------------------------------------------------------------
// THE AGENT LOOP
// ---------------------------------------------------------------------------
// One agent working until it has an answer: think, use tools, look at the results, repeat.
// msgs is the conversation it sees (it adds its own tool calls and final answer to it).
// opts: system prompt (text, or a function so memory changes show up mid-job), tools it may use,
// quiet (don't show its text as the answer yet: a draft, or a helper's report), who (name on its steps),
// compact (keep the conversation within CONTEXT_CHARS), spawn (starts a helper agent), maxSteps.
// Returns its final text, or null if it ran out of steps.
async function agentLoop(msgs, view, signal, opts) {
  const { system, tools = TOOLS, quiet = false, who = "", compact = false, spawn = null, maxSteps = MAX_STEPS } = opts;
  const tag = (label) => (who ? `${who}: ${label}` : label);
  let badCalls = 0;
  for (let step = 1; step <= maxSteps; step++) {
    if (compact) await compactContext(msgs, view, signal); else repairToolPairs(msgs);
    // THINK (streamed, so the status can show what's actually going on)
    const thinkStart = Date.now();
    view.waiting(currentModel());
    let msg;
    try {
      msg = await streamLLM({
        model: currentModel(),
        messages: [{ role: "system", content: typeof system === "function" ? system() : system }, ...msgs],
        tools, tool_choice: "auto", temperature: 0.3,
      }, signal, {
        reasoning: (chunk, all) => view.thinking(all, chunk.length),
        content: (chunk, all) => (quiet ? view.drafting(chunk.length) : view.answer(all, chunk.length)),
        tool: (call) => view.forming(call.function.name, call.function.arguments),
      });
    } catch (e) {
      if (e.code === "tool_use_failed" && badCalls < 2) {
        badCalls++;
        if (!quiet) view.dropAnswer();
        view.addStep({ icon: "retry", label: tag("Retried a tool call that came out garbled"), detail: e.message });
        msgs.push({ role: "user", content: "[harness note] Your last tool call was malformed and was not run. Retry with valid JSON arguments that match the tool's schema." });
        continue;
      }
      throw e;
    }

    if (msg.reasoning) {
      view.addStep({ icon: "think", label: tag(`Thought for ${fmtDuration(Date.now() - thinkStart)}`), detail: msg.reasoning });
    }

    // ACT + OBSERVE
    if (msg.tool_calls && msg.tool_calls.length) {
      if (msg.content) {   // a note to itself before using a tool, not the final answer
        if (!quiet) view.dropAnswer();
        view.addStep({ icon: "note", label: tag(thoughtSnippet(msg.content, 70) || "Planned the next step"), detail: msg.content });
      }
      msgs.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });
      const allowed = new Set(tools.map((t) => t.function.name));
      const runOne = async (tc, together) => {
        const name = tc.function.name;
        const args = parseArgs(tc.function.arguments);
        if (!together && name !== "update_plan") view.running(name, args);
        let image = null;
        const result = allowed.has(name)
          ? await executeTool(name, tc.function.arguments, {
            signal, view, spawn,
            onProgress: (p) => { if (!together) view.progress(p === "Running Python" ? describe(name, args, false) : p); },
            onImage: (src) => { image = src; view.peek(src); },
          })
          : `Error: you can't use ${name} here. Available: ${[...allowed].join(", ")}`;
        const failed = /^Error/.test(result) || /exit code: 1/.test(result);
        if (name !== "update_plan" || failed) {
          view.addStep({ icon: name, label: tag(describe(name, args, true) + (failed ? " (hit an error)" : "")), detail: stepDetail(name, args, result), image });
        }
        return { role: "tool", tool_call_id: tc.id, content: result };
      };
      // independent lookups (and helpers) run at the same time; anything that changes files runs on its own
      const calls = msg.tool_calls;
      for (let i = 0; i < calls.length;) {
        let j = i;
        if (PARALLEL_SAFE.has(calls[i].function.name)) while (j + 1 < calls.length && PARALLEL_SAFE.has(calls[j + 1].function.name)) j++;
        const group = calls.slice(i, j + 1);
        if (group.length > 1) view.together(group.map((tc) => [tc.function.name, parseArgs(tc.function.arguments)]));
        const results = await Promise.all(group.map((tc) => runOne(tc, group.length > 1)));
        msgs.push(...results);
        i = j + 1;
      }
      continue;
    }

    // CHECK -> DONE
    msgs.push({ role: "assistant", content: msg.content || "" });
    return msg.content || "";
  }
  return null;
}

// Helper agents run at most 3 at a time (free tiers have tight rate limits).
const helperSlots = { free: 3, waiting: [] };
async function withHelperSlot(fn) {
  if (helperSlots.free > 0) helperSlots.free--;
  else await new Promise((r) => helperSlots.waiting.push(r));
  try { return await fn(); } finally {
    const next = helperSlots.waiting.shift();
    if (next) next(); else helperSlots.free++;
  }
}

// ---------------------------------------------------------------------------
// DEBATE: the provider picked in Settings (the lead) does the work; the other one reviews it.
// They go back and forth until the reviewer agrees, up to DEBATE_ROUNDS reviews.
// ---------------------------------------------------------------------------
const DEBATE_ROUNDS = 3;
const REVIEW_TOOL_NAMES = new Set(["web_search", "fetch_webpage", "calculator", "read_file", "list_files", "screenshot", "get_current_time"]);
const REVIEW_TOOLS = TOOLS.filter((t) => REVIEW_TOOL_NAMES.has(t.function.name));

function reviewerPrompt(lead, leadModel) {
  const now = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" });
  return `You are the reviewer in Mini Agent, a chat app where two AIs work on each request together. Another AI (${lead}, model ${leadModel}) did the work and wrote a draft answer for the user. You and it debate until you agree, then the user gets the answer.

Current date and time: ${now}.

Your job: catch what would make the answer wrong or worse for the user.
- Factual errors, outdated information, wrong numbers or maths, things the user asked for that are missing, problems in the files it made, misleading or unclear wording.
- Verify the claims that matter with your tools instead of trusting the draft: web_search and fetch_webpage for facts, calculator for maths, screenshot or read_file to look at the files it made. You can't change files yourself.
- Raise only points that materially improve the answer. Don't nitpick style or wording preferences. If the draft is good, agree.
- If the other AI pushes back on one of your points with a good reason, accept it.

Reply in exactly this format:
VERDICT: AGREE
or
VERDICT: CHANGES
For AGREE, add one or two sentences on what you checked. For CHANGES, add a numbered list of the specific points still open: what is wrong, your evidence, what to do. Under 200 words.`;
}

// What the lead did this turn (tool calls and what came back), so the reviewer can judge the evidence.
function workSummary(msgs, max = 9000) {
  const lines = [];
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) lines.push(`-> ${tc.function.name}(${truncate(tc.function.arguments || "", 700)})`);
    } else if (m.role === "tool") lines.push(`<- ${truncate(m.content || "", 900)}`);
  }
  const text = lines.join("\n");
  return text ? truncate(text, max) : "(It answered without using any tools.)";
}

function splitReply(text) {
  const m = String(text || "").match(/<reply>([\s\S]*?)<\/reply>/i);
  if (!m) return { reply: "", answer: String(text || "").trim() };
  return { reply: m[1].trim(), answer: String(text).replace(m[0], "").trim() };
}

function readVerdict(review) {
  const v = (String(review).match(/VERDICT:\s*\**\s*(AGREE|CHANGES)/i) || [])[1];
  const body = String(review).replace(/^.*VERDICT:.*$/im, "").trim();
  const agreed = v ? v.toUpperCase() === "AGREE" : !/^\s*\d+[.)]\s/m.test(body);   // no verdict: a list of points means changes
  const points = (body.match(/^\s*\d+[.)]\s/gm) || []).length;
  return { agreed, body: body || String(review).trim(), points };
}

async function debate({ question, draft, turnMsg, madeFiles, view, signal }) {
  const turnStart = state.history.indexOf(turnMsg) + 1;
  const short = (m) => m.split("/").pop();
  const leadModel = mainModel(), revModel = reviewModel();
  let L = modelName(leadModel), R = modelName(revModel);
  if (L === R) { L += " (writer)"; R += " (reviewer)"; }   // the same model can review itself, with fresh eyes
  const earlier = state.history.slice(0, turnStart - 1)
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content && !m.tool_calls)
    .slice(-4).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${truncate(m.content, 1200)}`).join("\n\n");
  const revMsgs = [{ role: "user", content:
    (earlier ? `Earlier in this chat:\n${earlier}\n\n` : "") +
    `The user's request:\n${question}\n\n` +
    `What ${L} did (tool calls and results):\n${workSummary(state.history.slice(turnStart))}\n\n` +
    (madeFiles.length ? `Files it made (you can screenshot or read them): ${madeFiles.join(", ")}\n\n` : "") +
    `${L}'s draft answer:\n"""\n${draft}\n"""\n\nReview it.` }];
  const leadMsgs = state.history.slice();
  let current = draft;
  const result = { text: draft, rounds: 0, agreed: false, with: R };

  for (let round = 1; round <= DEBATE_ROUNDS; round++) {
    // the reviewer checks the current answer
    view.speaker(R, "review");
    view.progress(round === 1 ? `${R} is reviewing ${L}'s answer` : `${R} is checking ${L}'s changes`);
    let review;
    state.speaker = revModel;
    try {
      review = await agentLoop(revMsgs, view, signal, { system: reviewerPrompt(L, short(leadModel)), tools: REVIEW_TOOLS, quiet: true, who: R });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      view.addStep({ icon: "alert", label: `Couldn't get ${R}'s review, so ${L}'s answer stands`, detail: e.message });
      break;
    } finally { state.speaker = null; }
    if (review === null) break;
    result.rounds = round;
    const v = readVerdict(review);
    if (v.agreed) {
      view.addStep({ icon: "debate", label: `${R} agreed${round > 1 ? ` after ${round} rounds` : ""}`, detail: v.body });
      result.agreed = true;
      break;
    }
    view.addStep({ icon: "debate", label: `${R} pushed back${v.points ? ` on ${v.points} point${v.points === 1 ? "" : "s"}` : ""}`, detail: v.body });

    // the lead weighs the points, fixes what's right, and answers again
    const last = round === DEBATE_ROUNDS;
    view.speaker(L, "lead");
    view.progress(`${L} is weighing ${R}'s points`);
    leadMsgs.push({ role: "user", content:
      `[Debate, round ${round}] Before the user sees your answer, ${R} (model ${short(revModel)}) reviewed it and raised these points:\n\n${v.body}\n\n` +
      `Judge each point on its merits: the reviewer can be wrong too. Verify with tools where it matters, fix any files that need it, and keep what you're confident is right.\n\n` +
      `Reply in exactly this shape:\n<reply>To ${R}, in 1 to 4 short sentences: what you changed, and which points you disagree with and why.</reply>\n` +
      `Then the complete final answer for the user (the whole answer, not just the changes). Don't mention the review or the other AI in it.` +
      (last ? `\n\nThis is the last round. If you still disagree with ${R} on something important, add one short line at the end of the answer telling the user what you two disagree on.` : "") });
    let revised;
    try {
      revised = await agentLoop(leadMsgs, view, signal, { system: systemPrompt, tools: leadTools(), quiet: true, who: L, spawn: state.spawn });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      view.addStep({ icon: "alert", label: `${L} couldn't revise the answer, so the earlier one stands`, detail: e.message });
      break;
    }
    if (revised === null) break;
    const { reply, answer } = splitReply(revised);
    if (answer) current = answer;
    view.addStep({ icon: "debate", label: reply ? `${L} replied: ${thoughtSnippet(reply, 70)}` : `${L} revised the answer`,
      detail: (reply ? reply + "\n\n— Revised answer —\n" : "") + current });
    if (last) break;
    revMsgs.push({ role: "user", content:
      `${L} replied: ${reply || "(no comment)"}\n\nIts revised answer:\n"""\n${current}\n"""\n\n` +
      `Check whether your points were dealt with (look at changed files again if needed). Accept pushback that has a good reason. Same format, listing only points still open.` });
  }
  view.speaker(null);
  result.text = current;
  return result;
}


// What a helper's work looks like on the shared status line: "Helper 2: Searching the web for …"
function helperView(parent, label) {
  let last = "";
  const say = (t) => parent.progress(`${label}: ${t}`);
  return {
    waiting() {}, speaker() {}, writingFinal() {}, dropAnswer() {}, plan() {},
    thinking(all, chars) {
      parent.feed(chars);
      const s = thoughtSnippet(all.replace(/[^.!?:;\n]*$/, ""), 70);
      if (s && s.length >= 16 && s !== last) { last = s; say(s); }
    },
    forming(name, raw) { parent.feed(6); if (name !== "update_plan") { const t = describeForming(name, raw); if (t !== last) { last = t; say(t); } } },
    running(name, args) { say(describe(name, args, false)); },
    together(items) { say(`doing ${items.length} things at once`); },
    progress(t) { say(t); },
    drafting(chars) { parent.feed(chars); },
    answer(all, chars) { parent.feed(chars); },
    peek(src) { parent.peek(src); },
    addStep(step) { parent.addStep(step); },
    feed(chars) { parent.feed(chars); },
    partialAnswer() { return ""; },
  };
}


// ---------------------------------------------------------------------------
// One job: a user message, worked on until there's an answer (server version of runTurn).
// view: where live progress goes (the event log the phone streams).
// Returns { turn, history, memory } for the phone to save.
// ---------------------------------------------------------------------------
export async function runJob(job, view) {
  const ctx = {
    settings: job.settings, history: job.history, memory: job.memory, tz: job.tz, files: job.files,
    speaker: null, spawn: null, ask: job.ask,
    rateNotice: (secs, n) => view.progress(`OpenRouter asked us to slow down. Trying again in ${secs}s${n > 1 ? ` (attempt ${n + 1})` : ""}`),
  };
  return jobStore.run(ctx, () => runTurnOnServer(job, view));
}

async function runTurnOnServer(job, view) {
  const { text, attached = [], signal } = job;
  const note = attached.length
    ? `\n\n[The user attached ${attached.length === 1 ? "a file" : `${attached.length} files`}: ` +
      attached.map((p) => `${p} (${fileInfo(p).label}${files.has(p) ? `, ${humanSize(files.get(p).bytes.length)}` : ""})`).join(", ") +
      ". They're in your workspace.]"
    : "";
  const turnMsg = { role: "user", content: (text || "Please look at the attached file" + (attached.length > 1 ? "s." : ".")) + note };
  state.history.push(turnMsg);
  const turn = { kind: "agent", text: "", steps: [], files: [], ms: 0 };
  view.bind(turn);
  const started = Date.now();
  const before = files.snapshot();
  const changedFiles = () => { const now = files.snapshot(); return [...now.keys()].filter((p) => before.get(p) !== now.get(p)); };
  const debating = debateReady();

  let helpers = 0;
  const spawn = (task, sig) => withHelperSlot(async () => {
    const label = `Helper ${++helpers}`;
    const hv = helperView(view, label);
    hv.progress(`Starting: ${thoughtSnippet(task, 60)}`);
    const msgs = [{ role: "user", content: task }];
    const report = await agentLoop(msgs, hv, sig, { system: helperPrompt, tools: helperTools(), quiet: true, who: label, compact: true, maxSteps: HELPER_STEPS });
    if (report === null) return `${label} ran out of steps before finishing. What it had so far:\n${workSummary(msgs, 4000)}`;
    return report || `${label} finished without writing a report.`;
  });
  state.spawn = spawn;

  const finish = (patch) => {
    Object.assign(turn, patch);
    turn.ms = Date.now() - started;
    turn.files = changedFiles();
    return { turn, history: state.history, memory: state.memory };
  };

  try {
    if (debating) view.speaker(modelName(mainModel()) === modelName(reviewModel()) ? `${modelName(mainModel())} (writer)` : modelName(mainModel()), "lead");
    let answer = await agentLoop(state.history, view, signal, { system: systemPrompt, tools: leadTools(), quiet: debating, compact: true, spawn });
    if (answer === null) {
      state.history.push({ role: "assistant", content: `I stopped after ${MAX_STEPS} steps without finishing.` });
      return finish({ text: `I stopped after ${MAX_STEPS} steps without finishing. Say "continue" to let me keep going.` });
    }
    let debated = null;
    if (debating) {
      view.addStep({ icon: "note", label: `${modelName(mainModel())} drafted an answer`, detail: answer });
      debated = await debate({ question: text || turnMsg.content, draft: answer, turnMsg, madeFiles: changedFiles(), view, signal });
      answer = debated.text;
      state.history[state.history.length - 1] = { role: "assistant", content: answer };
      view.writingFinal();
    }
    return finish({ text: answer || "(It finished without saying anything. Try rephrasing.)", debate: debated && { with: debated.with, rounds: debated.rounds, agreed: debated.agreed } });
  } catch (e) {
    state.speaker = null;
    if (e.name === "AbortError" || (signal && signal.aborted)) {
      repairToolPairs(state.history);
      const partial = view.partialAnswer();
      state.history.push({ role: "assistant", content: partial ? partial + "\n\n(The user stopped this reply.)" : "(The user stopped this request.)" });
      return finish({ text: partial, stopped: true });
    }
    const at = state.history.indexOf(turnMsg);
    if (at >= 0) state.history.splice(at);
    return finish({ kind: "error", text: e.message || String(e), retry: text, retryFiles: attached.length ? attached : undefined });
  }
}

export { APP_VERSION_ENGINE, describe, fileInfo, humanSize, cleanPath };
const APP_VERSION_ENGINE = "4.2.0";
