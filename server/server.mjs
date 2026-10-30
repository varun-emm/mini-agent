// Mini Agent server: runs the agent for the phone app. The phone keeps the chats; for each message it
// sends the conversation and the files the job needs, then watches live progress and saves the result.
// Built for a small free host (512 MB, sleeps when idle), so it stores nothing that matters for long.
//
// Environment:
//   OPENROUTER_API_KEY  your OpenRouter key (required)
//   APP_PASSWORD        the password the app signs in with (required)
//   ALLOWED_ORIGINS     sites allowed to call the server (default https://varun-emm.github.io)
//   PORT                port to listen on (default 10000)
//   PUBLIC_URL          this server's public address, for keep-awake pings (Render sets RENDER_EXTERNAL_URL)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runJob, cleanPath, APP_VERSION_ENGINE } from "./engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");                         // the app's own files (index.html, app.js, ...)
const DATA = process.env.DATA_DIR || "/tmp/mini-agent";
const BLOBS = path.join(DATA, "blobs");
const JOBS_DIR = path.join(DATA, "jobs");
fs.mkdirSync(DATA, { recursive: true, mode: 0o755 });
fs.mkdirSync(BLOBS, { recursive: true, mode: 0o700 });      // only the server reads the upload cache
fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o711 });   // Python can reach its own job folder, but can't list the others
fs.chmodSync(DATA, 0o755); fs.chmodSync(BLOBS, 0o700); fs.chmodSync(JOBS_DIR, 0o711);
const VERSION = APP_VERSION_ENGINE;
const PORT = Number(process.env.PORT) || 10000;
const KEY = process.env.OPENROUTER_API_KEY || "";
const PASSWORD = process.env.APP_PASSWORD || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://varun-emm.github.io").split(",").map((s) => s.trim()).filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const MAX_JOBS = Number(process.env.MAX_JOBS) || 2;          // jobs running at once (the free plan has 512 MB)
const KEEP_RESULTS_MS = 3 * 3600 * 1000;                     // finished results wait this long for the phone
const BLOB_CACHE_BYTES = 400 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sign-in: a password gives a signed token that survives the server sleeping and waking
// ---------------------------------------------------------------------------
const SECRET = crypto.createHash("sha256").update(`mini-agent|${process.env.SESSION_SECRET || ""}|${PASSWORD}|${KEY}`).digest();
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function makeToken(days = 90) {
  const body = b64u(JSON.stringify({ exp: Date.now() + days * 86400000 }));
  return `${body}.${b64u(crypto.createHmac("sha256", SECRET).update(body).digest())}`;
}
function tokenOk(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return false;
  const want = crypto.createHmac("sha256", SECRET).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now(); } catch (_) { return false; }
}
const failures = new Map();   // ip -> [timestamps]; slows down password guessing
function tooManyTries(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < 15 * 60000);
  failures.set(ip, recent);
  return recent.length >= 10;
}

// ---------------------------------------------------------------------------
// Files: a cache of uploaded files by content hash, and a workspace folder per job
// ---------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const blobPath = (h) => path.join(BLOBS, h);
function trimBlobs() {
  const all = fs.readdirSync(BLOBS).map((h) => { const st = fs.statSync(blobPath(h)); return { h, size: st.size, used: st.atimeMs }; });
  let total = all.reduce((n, b) => n + b.size, 0);
  for (const b of all.sort((x, y) => x.used - y.used)) {
    if (total <= BLOB_CACHE_BYTES) break;
    fs.rmSync(blobPath(b.h), { force: true });
    total -= b.size;
  }
}

class Workspace {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  abs(p) {
    const full = path.join(this.dir, cleanPath(p));
    if (!full.startsWith(this.dir + path.sep)) throw new Error("Use a simple file name, like notes/report.md");
    return full;
  }
  put(p, bytes) { const full = this.abs(p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, bytes); }
  get(p) {
    let full, st;
    try { full = this.abs(p); st = fs.statSync(full); } catch (_) { return undefined; }
    if (!st.isFile()) return undefined;
    return { path: p, size: st.size, mtime: st.mtimeMs, get bytes() { return new Uint8Array(fs.readFileSync(full)); } };
  }
  has(p) { return !!this.get(p); }
  remove(p) { try { fs.rmSync(this.abs(p), { force: true }); } catch (_) { /* gone */ } }
  paths() {
    const out = [];
    const walk = (dir, prefix) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "__pycache__") continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + "/");
        else if (e.isFile()) out.push(prefix + e.name);
      }
    };
    walk(this.dir, "");
    return out.sort();
  }
  snapshot() { return new Map(this.paths().map((p) => { const st = fs.statSync(this.abs(p)); return [p, `${st.mtimeMs}:${st.size}`]; })); }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
const jobs = new Map();
let running = 0;
const queue = [];

const DEFAULT_SETTINGS = {
  models: { openrouter: "moonshotai/kimi-k3.1-pro" }, visionModels: { openrouter: "anthropic/claude-haiku-5.5" },
  reviewModel: "anthropic/claude-sonnet-5.5", debate: false, memory: true, askBeforeCode: false,
  imageModel: "google/gemini-3.1-flash-image", videoModel: "google/veo-3.1-fast",
};
const isModelId = (s) => typeof s === "string" && /^[\w.\-/:]{3,120}$/.test(s);
function cleanSettings(s = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (isModelId(s.models?.openrouter)) out.models.openrouter = s.models.openrouter;
  if (isModelId(s.visionModels?.openrouter)) out.visionModels.openrouter = s.visionModels.openrouter;
  for (const k of ["reviewModel", "imageModel", "videoModel"]) if (isModelId(s[k])) out[k] = s[k];
  for (const k of ["debate", "memory", "askBeforeCode"]) if (typeof s[k] === "boolean") out[k] = s[k];
  return out;
}
function cleanTz(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch (_) { return "UTC"; }
}

// What the phone's live view gets: every view call becomes a small event, kept so a phone that
// reconnects (or opens the app later) can replay the whole job.
function makeView(job) {
  let turn = null, thinkLen = 0, ans = "", formKey = "", formRaw = "";
  const emit = (e) => {
    e.i = job.events.length;
    job.events.push(e);
    for (const fn of job.listeners) fn(e);
  };
  const slim = (args) => {
    const a = { ...(args || {}) };
    for (const [k, v] of Object.entries(a)) {
      if (typeof v !== "string") continue;
      if (k === "content") a[k] = v.slice(0, 200);
      else if (v.length > 20000) a[k] = v.slice(0, 20000);
    }
    return a;
  };
  const resetCall = () => { thinkLen = 0; ans = ""; formKey = ""; formRaw = ""; };
  return {
    emit,
    bind(t) { turn = t; },
    waiting(model) { resetCall(); emit({ t: "wait", model }); },
    thinking(all, n) { const d = all.slice(thinkLen); thinkLen = all.length; if (d) emit({ t: "think", d, n }); },
    drafting(n) { emit({ t: "draft", n }); },
    answer(all, n) {
      if (!all.startsWith(ans)) { ans = all; emit({ t: "ans", d: all, reset: true, n }); return; }
      const d = all.slice(ans.length); ans = all;
      if (d) emit({ t: "ans", d, n });
    },
    dropAnswer() { ans = ""; emit({ t: "drop" }); },
    forming(name, raw) {
      raw = String(raw || "");
      if (name === formKey && raw.startsWith(formRaw)) { const d = raw.slice(formRaw.length); formRaw = raw; if (d) emit({ t: "form", name, d }); return; }
      formKey = name; formRaw = raw;
      emit({ t: "form", name, raw, reset: true });
    },
    running(name, args) { emit({ t: "run", name, args: slim(args) }); },
    progress(text) { emit({ t: "prog", text }); },
    together(items) { emit({ t: "together", items: items.map(([n, a]) => [n, slim(a)]) }); },
    plan(items) { if (turn) turn.plan = items; emit({ t: "plan", items }); },
    peek(src) { emit({ t: "peek", src }); },
    addStep(step) {
      const s = { ...step, detail: step.detail ? String(step.detail).slice(0, 6000) : step.detail };
      if (turn) turn.steps.push(s);
      emit({ t: "step", step: s });
    },
    speaker(name, role) { emit({ t: "spk", name: name || null, role }); },
    writingFinal() { emit({ t: "final" }); },
    feed(n) { emit({ t: "feed", n }); },
    partialAnswer() { return ans; },
  };
}

function startJob(job) {
  if (running >= MAX_JOBS) { queue.push(job); job.view.progress("Waiting for another job on the server to finish"); return; }
  running++;
  job.status = "running";
  job.startedAt = Date.now();
  const base = { text: job.text, attached: job.attached, signal: job.controller.signal, settings: job.settings, history: job.history,
    memory: job.memory, tz: job.tz, files: job.ws, ask: job.ask };
  runJob(base, job.view).then((r) => finishJob(job, r), (e) => finishJob(job, {
    turn: { kind: "agent", text: "", steps: [], files: [], ms: Date.now() - job.startedAt },
    history: job.history, memory: job.memory, crash: e && e.message,
  })).finally(() => {
    running--;
    const next = queue.shift();
    if (next && next.status === "queued") startJob(next);
  });
}
function finishJob(job, r) {
  if (r.crash) r.turn = { ...r.turn, kind: "error", text: `The server hit a problem: ${r.crash}`, retry: job.text };
  const now = job.ws.snapshot();
  const changed = (r.turn.files || []).filter((p) => now.has(p)).map((p) => { const f = job.ws.get(p); return { path: p, size: f.size, mtime: f.mtime }; });
  const removed = job.initialPaths.filter((p) => !now.has(p));
  job.result = { turn: r.turn, history: r.history, memory: r.memory, files: { changed, removed } };
  job.status = "done";
  job.finishedAt = Date.now();
  for (const a of job.asks.values()) a.resolve(false);
  job.view.emit({ t: "done", result: job.result });
}

function newJob(body) {
  const id = crypto.randomBytes(9).toString("base64url");
  const dir = path.join(JOBS_DIR, id);
  const ws = new Workspace(path.join(dir, "ws"));
  const manifest = Array.isArray(body.files) ? body.files : [];
  for (const f of manifest) {
    if (!/^[a-f0-9]{64}$/.test(f.sha256 || "")) throw Object.assign(new Error("bad file list"), { status: 400 });
    fs.copyFileSync(blobPath(f.sha256), ws.abs(f.path), fs.constants.COPYFILE_FICLONE);
    const full = ws.abs(f.path);
    if (f.mtime) { const t = new Date(f.mtime); fs.utimesSync(full, t, t); }
  }
  const job = {
    id, dir, ws, status: "queued", events: [], listeners: new Set(), asks: new Map(), createdAt: Date.now(),
    chatId: String(body.chatId || "").slice(0, 80), text: String(body.text || "").slice(0, 100000),
    attached: (Array.isArray(body.attached) ? body.attached : []).map(String).slice(0, 50),
    history: Array.isArray(body.history) ? body.history : [], memory: Array.isArray(body.memory) ? body.memory.slice(0, 60) : [],
    settings: cleanSettings(body.settings), tz: cleanTz(body.tz), controller: new AbortController(), acked: false,
    initialPaths: manifest.map((f) => cleanPath(f.path)),
  };
  job.view = makeView(job);
  // a question for the person (video price, run this code?). Waits up to 15 minutes, then counts as "no".
  job.ask = (kind, text) => new Promise((resolve) => {
    const askId = crypto.randomBytes(6).toString("base64url");
    const timer = setTimeout(() => answer(false), 15 * 60000);
    const answer = (yes) => {
      if (!job.asks.has(askId)) return;
      clearTimeout(timer);
      job.asks.delete(askId);
      job.view.emit({ t: "answered", id: askId, yes: !!yes });
      resolve(!!yes);
    };
    job.asks.set(askId, { resolve: answer });
    job.view.emit({ t: "ask", id: askId, kind, text: String(text).slice(0, 4000) });
  });
  jobs.set(id, job);
  startJob(job);
  return job;
}

// Clean up: results nobody collected, and their files
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const expired = job.status === "done" && (job.acked ? now - job.finishedAt > 10 * 60000 : now - job.finishedAt > KEEP_RESULTS_MS);
    if (expired) { fs.rmSync(job.dir, { recursive: true, force: true }); jobs.delete(id); }
  }
  try { trimBlobs(); } catch (_) { /* best effort */ }
}, 5 * 60000).unref();

// Keep awake: free hosts sleep after ~15 minutes without visits, wiping everything. While a job is running
// or a finished result is waiting for the phone, the server visits itself so the work isn't lost.
setInterval(() => {
  if (!PUBLIC_URL) return;
  const busy = [...jobs.values()].some((j) => j.status !== "done" || (!j.acked && Date.now() - j.finishedAt < KEEP_RESULTS_MS));
  if (busy) fetch(`${PUBLIC_URL}/api/health`).catch(() => {});
}, 8 * 60000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
  ".md": "text/markdown; charset=utf-8", ".jpg": "image/jpeg", ".gif": "image/gif", ".mp4": "video/mp4", ".pdf": "application/pdf" };
const STATIC = new Set(["index.html", "app.js", "styles.css", "py-worker.js"]);

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJSON = async (req, limit = 25 * 1024 * 1024) => { try { return JSON.parse((await readBody(req, limit)).toString() || "{}"); } catch (e) { throw e.status ? e : Object.assign(new Error("Bad JSON"), { status: 400 }); } };
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const ok = STATIC.has(rel) || /^assets\/[\w.\-]+$/.test(rel);
  if (!ok) return send(res, 404, "Not found");
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return send(res, 404, "Not found");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(full)] || "application/octet-stream",
    "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(full).pipe(res);
}

function streamEvents(req, res, job, after) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
  const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  for (const e of job.events.slice(after)) write(e);
  if (job.status === "done") { res.end(); return; }
  const fn = (e) => { write(e); if (e.t === "done") cleanup(true); };
  const beat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const cleanup = (end) => { clearInterval(beat); job.listeners.delete(fn); if (end) res.end(); };
  job.listeners.add(fn);
  req.on("close", () => cleanup(false));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  cors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  try {
    if (!p.startsWith("/api/")) return req.method === "GET" ? serveStatic(req, res, p) : send(res, 405, "Method not allowed");
    if (p === "/api/health") {
      const missing = [!KEY && "OPENROUTER_API_KEY", !PASSWORD && "APP_PASSWORD"].filter(Boolean);
      return send(res, 200, { ok: !missing.length, version: VERSION, missing, jobs: jobs.size });
    }
    if (p === "/api/login" && req.method === "POST") {
      if (!PASSWORD || !KEY) return send(res, 503, { error: "The server isn't set up yet: add OPENROUTER_API_KEY and APP_PASSWORD in your host's settings." });
      const ip = clientIp(req);
      if (tooManyTries(ip)) return send(res, 429, { error: "Too many wrong passwords. Wait 15 minutes and try again." });
      const { password } = await readJSON(req, 10000);
      const a = crypto.createHash("sha256").update(String(password || "")).digest();
      const b = crypto.createHash("sha256").update(PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, b)) { failures.get(ip).push(Date.now()); return send(res, 401, { error: "That password isn't right." }); }
      return send(res, 200, { token: makeToken(), version: VERSION });
    }
    const auth = String(req.headers.authorization || "");
    if (!tokenOk(auth.replace(/^Bearer\s+/i, ""))) return send(res, 401, { error: "Sign in again." });

    if (p === "/api/me") return send(res, 200, { ok: true, version: VERSION });
    if (p === "/api/blobs/check" && req.method === "POST") {
      const { hashes } = await readJSON(req, 200000);
      const missing = (Array.isArray(hashes) ? hashes : []).filter((h) => /^[a-f0-9]{64}$/.test(h) && !fs.existsSync(blobPath(h)));
      return send(res, 200, { missing });
    }
    let m;
    if ((m = p.match(/^\/api\/blobs\/([a-f0-9]{64})$/)) && req.method === "PUT") {
      const buf = await readBody(req, 30 * 1024 * 1024);
      if (sha256(buf) !== m[1]) return send(res, 400, { error: "The file arrived damaged. Try again." });
      fs.writeFileSync(blobPath(m[1]), buf);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/jobs" && req.method === "POST") {
      const body = await readJSON(req);
      const missing = (body.files || []).map((f) => f.sha256).filter((h) => !/^[a-f0-9]{64}$/.test(h || "") || !fs.existsSync(blobPath(h)));
      if (missing.length) return send(res, 409, { error: "Some files haven't been uploaded yet.", missing });
      const job = newJob(body);
      return send(res, 200, { id: job.id });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)(\/.*)?$/))) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "The server doesn't have this job any more (it may have restarted)." });
      const rest = m[2] || "";
      if (rest === "" && req.method === "GET") return send(res, 200, { id: job.id, status: job.status, events: job.events.length, result: job.status === "done" ? job.result : null });
      if (rest === "" && req.method === "DELETE") { job.acked = true; return send(res, 200, { ok: true }); }
      if (rest === "/events" && req.method === "GET") return streamEvents(req, res, job, Math.max(0, Number(url.searchParams.get("after")) || 0));
      if (rest === "/stop" && req.method === "POST") { job.controller.abort(); for (const a of job.asks.values()) a.resolve(false); return send(res, 200, { ok: true }); }
      if (rest === "/answer" && req.method === "POST") {
        const { id, yes } = await readJSON(req, 10000);
        const a = job.asks.get(String(id));
        if (a) a.resolve(!!yes);
        return send(res, 200, { ok: true });
      }
      if (rest.startsWith("/files/") && req.method === "GET") {
        const rel = decodeURIComponent(rest.slice(7));
        const f = job.ws.get(rel);
        if (!f) return send(res, 404, { error: "No such file." });
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": f.size, "Cache-Control": "no-store" });
        return fs.createReadStream(job.ws.abs(rel)).pipe(res);
      }
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : `Server error: ${e.message}` });
  }
});
server.requestTimeout = 0;           // live event streams stay open for as long as a job runs
server.headersTimeout = 65000;
server.listen(PORT, () => console.log(`Mini Agent server ${VERSION} listening on :${PORT}${KEY && PASSWORD ? "" : " (set OPENROUTER_API_KEY and APP_PASSWORD)"}`));
