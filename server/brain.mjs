// opencode as the brain: the open-source agent harness (github.com/anomalyco/opencode) runs each job.
//
//   phone ──job──> myGPT server ──prompt──> opencode serve (localhost only, low-privilege user)
//                       ▲   ▲                    │ model calls          │ myGPT tools (MCP)
//                       │   └──── /llm/<provider> ┘                     │ web search, pages, pictures,
//                       └──────────────────────── /mcp/<job> ───────────┘ video, screenshots, memory
//
// opencode never sees your API keys: it calls the model through this server, which adds the key.
// It runs as the "sandbox" user with a bare environment, like Python did before, so the code it runs
// can't read the server's secrets. Its live events are turned into the same progress the phone already shows.
//
// opencode needs about 1 GB of memory (measured: ~230 MB idle, 450-740 MB while working), so on a small
// server (Render's free 512 MB) myGPT's own harness runs instead.
// For now it's off unless you ask for it: BRAIN=opencode (or BRAIN=auto: opencode when there's ~1 GB of memory).
// The Docker image doesn't include opencode yet; see the README's "opencode brain (experimental)".
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import net from "node:net";
import { jobStore, TOOLS, executeTool, helperView, describe, modelName, PROVIDERS, stepDetail, debate, thoughtSnippet, fileInfo, humanSize } from "./engine.mjs";
import { sandboxUser, chownTree, FONT_DIR } from "./sandbox.mjs";

const BASES = {
  openrouter: (process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  uberllm: (process.env.UBERLLM_BASE || "https://api.uberllm.dev/v1").replace(/\/+$/, ""),
};
const KEYS = { openrouter: process.env.OPENROUTER_API_KEY || "", uberllm: process.env.UBERLLM_API_KEY || "" };
const RECYCLE_MB = Number(process.env.OPENCODE_RECYCLE_MB) || 600;   // restart opencode between jobs once it grows past this
const NEED_BYTES = 900 * 1024 * 1024;
const CONTEXT_TOKENS = Number(process.env.OPENCODE_CONTEXT) || 200000;   // compact long jobs before they get expensive

// How much memory this container may use (the cgroup limit, else the machine's).
export function memoryLimit() {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const n = Number(fs.readFileSync(f, "utf8").trim());
      if (n > 0 && n < 2 ** 50) return Math.min(n, os.totalmem());
    } catch (_) { /* not there */ }
  }
  return os.totalmem();
}
function findBin() {
  if (process.env.OPENCODE_BIN) return fs.existsSync(process.env.OPENCODE_BIN) ? process.env.OPENCODE_BIN : null;
  for (const d of String(process.env.PATH || "").split(":")) {
    const p = path.join(d, "opencode");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* keep looking */ }
  }
  return null;
}
const isLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeBrain({ port, dataDir, log = console.log }) {
  const mode = String(process.env.BRAIN || "builtin").toLowerCase();
  const bin = findBin();
  const limit = memoryLimit();
  let why = "";
  if (mode === "builtin") why = "the default; opencode is experimental";
  else if (!bin) why = "opencode isn't installed on this server";
  else if (mode !== "opencode" && limit < NEED_BYTES) why = `this server has ${Math.round(limit / 2 ** 20)} MB of memory and opencode needs about 1 GB`;
  const enabled = !why;
  // opencode's home: its config, caches and the plugin kit it installs once (the Docker image pre-fills it)
  const home = process.env.OPENCODE_HOME || path.join(dataDir, "opencode-home");
  const pass = crypto.randomBytes(18).toString("base64url");
  const proxyToken = crypto.randomBytes(24).toString("base64url");
  const active = new Map();     // job id -> { ctx, token, view, calls: Map(request id -> AbortController) }
  let proc = null, ready = null, version = "", ocPort = 0;
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const rssMB = () => { try { return Number((fs.readFileSync(`/proc/${proc.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/) || [])[1]) / 1024; } catch (_) { return 0; } };

  // ---- the opencode process ----------------------------------------------
  function baseConfig() {
    const provider = {};
    for (const id of Object.keys(PROVIDERS)) {
      provider[`mygpt-${id}`] = {
        npm: "@ai-sdk/openai-compatible", name: PROVIDERS[id].name,
        options: { baseURL: `http://127.0.0.1:${port}/llm/${id}/v1`, apiKey: proxyToken },
        models: {},
      };
    }
    return {
      $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", snapshot: false, subagent_depth: 1,
      provider,
      // nothing outside the job's folder; no web fetching around myGPT's page reader; never ask the phone questions
      permission: { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "deny", question: "deny" },
    };
  }
  async function start() {
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
    const configFile = path.join(home, "opencode.json");
    fs.writeFileSync(configFile, JSON.stringify(baseConfig(), null, 1));
    chownTree(home);
    const pyDir = process.env.PYTHON ? path.dirname(process.env.PYTHON) : "";
    const env = {
      PATH: [pyDir, process.env.PATH || "/usr/local/bin:/usr/bin:/bin"].filter(Boolean).join(":"),
      HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "C.UTF-8", MPLBACKEND: "Agg",
      MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(home, "tmp"),
      OPENCODE_CONFIG: configFile, OPENCODE_SERVER_PASSWORD: pass,
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      BUN_OPTIONS: process.env.OPENCODE_BUN_OPTIONS || "--smol",
      BUN_JSC_forceRAMSize: process.env.OPENCODE_HEAP || "300000000",     // makes its memory clean-up keep it smaller
    };
    if (FONT_DIR) env.MYGPT_FONT_DIR = FONT_DIR;
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "npm_config_cafile"]) if (process.env[k]) env[k] = process.env[k];
    const opts = { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] };
    if (sandboxUser) Object.assign(opts, sandboxUser);
    ocPort = await freePort();
    proc = spawn(bin, ["serve", "--port", String(ocPort), "--hostname", "127.0.0.1"], opts);
    const mine = proc;
    const say = (d) => { const t = String(d).trim(); if (t && !/^timestamp=/.test(t)) log(`[opencode] ${t.slice(0, 400)}`); };
    proc.stdout.on("data", say); proc.stderr.on("data", say);
    proc.on("exit", (code, sig) => { log(`[opencode] stopped (${sig || code})`); if (proc === mine) { proc = null; ready = null; } });
    for (let i = 0; i < 120; i++) {
      try {
        // a request sent while opencode is still booting can hang, so each check gives up after 2 seconds
        const h = await oc("/global/health", { signal: AbortSignal.timeout(2000) });
        if (h && h.healthy) { version = h.version || ""; log(`[opencode] ${version} ready${sandboxUser ? " (sandbox user)" : ""}`); return; }
      } catch (_) { /* starting */ }
      if (!proc) throw new Error("opencode didn't start");
      await sleep(250);
    }
    throw new Error("opencode didn't start in 30 seconds");
  }
  const ensure = () => (ready ||= start().catch((e) => { ready = null; try { proc && proc.kill(); } catch (_) { /* gone */ } throw e; }));

  async function oc(p, { method = "GET", body, directory, signal, raw = false } = {}) {
    const u = new URL(`http://127.0.0.1:${ocPort}${p}`);
    if (directory) u.searchParams.set("directory", directory);
    const res = await fetch(u, {
      method, signal, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: "Basic " + Buffer.from("opencode:" + pass).toString("base64"), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    if (raw) return res;
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
    try { return text ? JSON.parse(text) : null; } catch (_) { return text; }
  }

  // ---- model calls from opencode: add the real key ------------------------
  async function proxy(req, res, pid, rest) {
    if (!isLoopback(req) || String(req.headers.authorization || "") !== `Bearer ${proxyToken}`) { res.writeHead(403); return res.end(); }
    if (!KEYS[pid]) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: `This server has no ${PROVIDERS[pid].name} key.` } })); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    let up;
    try {
      up = await fetch(BASES[pid] + rest, {
        method: req.method, signal: ctrl.signal, body: chunks.length ? Buffer.concat(chunks) : undefined,
        headers: {
          Authorization: `Bearer ${KEYS[pid]}`, "Content-Type": req.headers["content-type"] || "application/json", Accept: req.headers.accept || "*/*",
          ...(pid === "openrouter" ? { "HTTP-Referer": "https://github.com/varun-emm/mini-agent", "X-Title": "myGPT" } : {}),
        },
      });
    } catch (e) {
      if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `Couldn't reach ${PROVIDERS[pid].name}: ${e.message}` } })); }
      return;
    }
    const keep = {};
    for (const h of ["content-type", "retry-after", "x-ratelimit-reset"]) { const v = up.headers.get(h); if (v) keep[h] = v; }
    res.writeHead(up.status, keep);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on("error", () => res.end()).pipe(res);
  }

  // ---- myGPT's own tools, offered to opencode over MCP --------------------
  const MCP_TOOLS = ["web_search", "fetch_webpage", "screenshot", "generate_image", "generate_video", "remember", "forget"];
  const TOOL_NOTE = {
    fetch_webpage: " Use this instead of curl for reading web pages: it handles sites that block simple downloads.",
    screenshot: " Paths are relative to the working folder.",
  };
  function mcpTools(job) {
    return TOOLS.filter((t) => MCP_TOOLS.includes(t.function.name) && (job.ctx.settings.memory || !["remember", "forget"].includes(t.function.name)))
      .map((t) => ({ name: t.function.name, description: t.function.description + (TOOL_NOTE[t.function.name] || ""), inputSchema: t.function.parameters }));
  }
  async function mcp(req, res, jobId) {
    const job = active.get(jobId);
    const reply = (status, obj) => { res.writeHead(status, obj ? { "Content-Type": "application/json" } : {}); res.end(obj ? JSON.stringify(obj) : undefined); };
    if (!isLoopback(req) || !job || String(req.headers.authorization || "") !== `Bearer ${job.token}`) return reply(403);
    if (req.method === "DELETE") return reply(200);
    if (req.method !== "POST") return reply(405);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let m;
    try { m = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const ok = (result) => reply(200, { jsonrpc: "2.0", id: m.id, result });
    if (m.method === "notifications/cancelled") { const c = job.calls.get(m.params && m.params.requestId); if (c) c.abort(); return reply(202); }
    if (m.id === undefined) return reply(202);
    if (m.method === "initialize") return ok({ protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mygpt", version: "5" } });
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list") return ok({ tools: mcpTools(job) });
    if (m.method !== "tools/call") return reply(200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Unknown method" } });
    const name = String(m.params && m.params.name || "");
    const args = (m.params && m.params.arguments) || {};
    if (!mcpTools(job).some((t) => t.name === name)) return ok({ content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true });
    const ctrl = new AbortController();
    const signal = AbortSignal.any([ctrl.signal, job.signal]);
    job.calls.set(m.id, ctrl);
    let image = null;
    try {
      const text = await jobStore.run(job.ctx, () => executeTool(name, JSON.stringify(args), {
        signal, view: job.view, spawn: null,
        onProgress: (p) => job.view.progress(p),
        onImage: (src) => { image = src; job.view.peek(src); },
      }));
      job.images.set(name + JSON.stringify(args), image);
      return ok({ content: [{ type: "text", text: String(text) }], isError: /^Error/.test(String(text)) });
    } catch (e) {
      return ok({ content: [{ type: "text", text: `Error: ${e.name === "AbortError" ? "stopped" : e.message}` }], isError: true });
    } finally { job.calls.delete(m.id); }
  }

  // ---- one job --------------------------------------------------------------
  function pickProvider(settings) {
    const want = PROVIDERS[settings.provider] ? settings.provider : "openrouter";
    if (KEYS[want]) return want;
    return Object.keys(PROVIDERS).find((id) => KEYS[id]) || want;
  }
  function transcript(history, max = 40000) {
    const lines = [];
    for (const m of history) {
      if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim() || m.tool_calls) continue;
      if (/^\[(harness note|Debate)/.test(m.content)) continue;
      lines.push(`${m.role === "user" ? "User" : "myGPT"}: ${m.content.trim()}`);
    }
    let out = lines.join("\n\n");
    if (out.length > max) out = "…(earlier messages left out)\n\n" + out.slice(out.length - max).replace(/^[^\n]*\n/, "");
    return out;
  }
  function systemText(ctx, history) {
    const now = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: ctx.tz });
    const facts = ctx.settings.memory ? ctx.memory.map((m) => `- ${m.text}`).join("\n") : "";
    const earlier = transcript(history);
    return `# You are myGPT
You are myGPT, a personal assistant that gets real work done: research, writing, numbers, documents, pictures and small apps. You run on opencode's agent harness on the user's own server, and the user talks to you from the myGPT app on their phone. Treat every request as a task to finish properly, not only coding.

Current date and time: ${now} (${ctx.tz}).

## Your workspace
- The working folder is this chat's workspace. Files the user attached are in it. Every file you create or change there appears in the chat automatically, where the user can preview, download and share it. Keep files in this folder with short, descriptive names, and don't paste their contents into your answer.
- Python 3 is installed with openpyxl, pandas, numpy, matplotlib, python-docx, python-pptx, fpdf2, reportlab, pypdf, pillow, xlsxwriter, requests, beautifulsoup4 and more. Run it with bash (python3 script.py). It has internet access. Don't pip install unless something is truly missing.
- Excel: real formulas, bold headers, sensible widths and number formats. Charts: matplotlib, plt.savefig("name.png", dpi=200, bbox_inches="tight"). PDFs with fpdf2: use the DejaVu fonts in ${FONT_DIR || "/usr/share/fonts/truetype/dejavu"} (DejaVuSans.ttf, DejaVuSans-Bold.ttf) so symbols like ₹ work.
- HTML files (games, pages, tools) open right inside the app when the user taps them: make them work with touch and fit a phone screen.

## myGPT tools (from the mygpt server)
- mygpt_web_search for anything current or factual. Don't rely on memory for prices, news, rates, people or versions.
- mygpt_fetch_webpage to read a page's actual text. Read the sources that matter instead of trusting snippets, and cite their URLs.
- mygpt_screenshot to check your work with eyes: after making a chart, PDF, Word, Excel, CSV or HTML file, screenshot it with a specific question (is the title right, are labels readable, is anything cut off) and fix what's wrong. It also shows what a web page looks like.
- mygpt_generate_image makes or edits pictures (photos, illustrations, logos, posters). For charts of data use Python instead.
- mygpt_generate_video makes short clips. Each one costs real money and the user must confirm the price, so use it only when asked.
${ctx.settings.memory ? `- mygpt_remember saves one short, lasting fact the user tells you about themselves (name, business, city, how they like answers), in their words; mygpt_forget removes one when asked. Never save passwords, keys, card, bank or ID numbers, or health details.` : "- Memory is turned off: don't try to save facts about the user."}

## How to work
- For any job with 3 or more steps, keep a todo list with todowrite: the user watches it as a live checklist.
- Use the task tool to hand independent, self-contained parts of a big job to helpers that work at the same time.
- Never do important maths in your head: calculate with Python.
- The user can't answer questions in the middle of a job. If something is unclear, make a sensible choice, say what you assumed, and finish.

## Your final answer
The user reads it on a phone: clear, concise Markdown. Briefly say what you checked, name the files you made with a line on what's in each, and list source URLs if you used the web.
${facts ? `\n## What you know about the user from earlier chats\n${facts}\n` : ""}${earlier ? `\n## The conversation so far\nEarlier messages in this chat (the user's new message follows):\n\n${earlier}\n` : ""}`;
  }

  // opencode's tools, in the names and shapes the phone's progress view understands
  function shape(tool, input, ws) {
    const rel = (p) => { const r = p ? path.relative(ws, path.resolve(ws, String(p))) : ""; return r && !r.startsWith("..") ? r : String(p || "").split("/").pop(); };
    const a = { ...(input || {}) };
    if (a.filePath) a.filePath = rel(a.filePath);
    if (tool.startsWith("mygpt_")) return [tool.slice(6), a];
    return [tool, a];
  }
  function toolDetail(name, args, state) {
    const out = state.status === "error" ? `Error: ${state.error || "it failed"}` : String(state.output || "");
    if (name === "bash") return `$ ${args.command || ""}\n\n${out}`.slice(0, 6000);
    if (name === "write") return `Wrote ${args.filePath}`;
    if (name === "edit") return `${args.filePath}\n\n- ${String(args.oldString || "").slice(0, 1500)}\n+ ${String(args.newString || "").slice(0, 1500)}`;
    if (name === "task") return `Task: ${args.prompt || args.description || ""}\n\n— Report —\n${out.replace(/<\/?task[^>]*>|<\/?task_result>/g, "").trim()}`;
    return stepDetail(name, args, out);
  }
  const PLAN_STATUS = { in_progress: "active", completed: "done", cancelled: "skipped", pending: "pending" };

  async function runJob(job, view) {
    await ensure();
    const ws = job.files.dir;
    const jobDir = path.dirname(ws);
    const pid = pickProvider(job.settings);
    const model = job.settings.models[pid] || PROVIDERS[pid].defaultModel;
    const ctx = {
      settings: { ...job.settings, provider: pid }, history: job.history, memory: job.memory, tz: job.tz, files: job.files,
      speaker: null, spawn: null, ask: job.ask,
      rateNotice: (secs) => view.progress(`${PROVIDERS[pid].name} asked us to slow down. Trying again in ${secs}s`),
    };
    const token = crypto.randomBytes(24).toString("base64url");
    const me = { ctx, token, view, signal: job.signal, calls: new Map(), images: new Map() };
    active.set(job.id, me);

    // this job's own settings: its model, its myGPT tools, and whether code needs the user's OK
    const models = {};
    for (const m of new Set([model, ctx.settings.visionModels[pid]].filter(Boolean))) {
      models[m] = { name: modelName(m), limit: { context: CONTEXT_TOKENS, output: 32000 }, tool_call: true, attachment: true, reasoning: true };
    }
    fs.writeFileSync(path.join(jobDir, "opencode.json"), JSON.stringify({
      provider: { [`mygpt-${pid}`]: { models } },
      mcp: { mygpt: { type: "remote", url: `http://127.0.0.1:${port}/mcp/${job.id}`, headers: { Authorization: `Bearer ${token}` }, oauth: false, timeout: 20 * 60000, enabled: true } },
      permission: { bash: job.settings.askBeforeCode ? "ask" : "allow" },
    }));
    chownTree(jobDir);

    const { text, attached = [] } = job;
    const note = attached.length
      ? `\n\n[The user attached ${attached.length === 1 ? "a file" : `${attached.length} files`}: ` +
        attached.map((p) => `${p} (${fileInfo(p).label}${job.files.has(p) ? `, ${humanSize(job.files.get(p).size)}` : ""})`).join(", ") + ". They're in your working folder.]"
      : "";
    const userText = (text || "Please look at the attached file" + (attached.length > 1 ? "s." : ".")) + note;
    const history = job.history.slice();
    const turnMsg = { role: "user", content: userText };
    const turn = { kind: "agent", text: "", steps: [], files: [], ms: 0, brain: "opencode" };
    view.bind(turn);
    const started = Date.now();
    const before = job.files.snapshot();
    const changedFiles = () => { const now = job.files.snapshot(); return [...now.keys()].filter((p) => before.get(p) !== now.get(p)); };
    const finish = (patch, hist) => {
      Object.assign(turn, patch);
      turn.ms = Date.now() - started;
      turn.files = changedFiles().filter((p) => !/^\.|\/\./.test(p));
      return { turn, history: hist, memory: ctx.memory };
    };

    // follow the job's events
    const evCtrl = new AbortController();
    const evRes = await oc("/event", { directory: ws, signal: evCtrl.signal, raw: true });
    const sessions = new Map();     // session id -> helper view (null for the main session)
    const labels = new Map();       // helper session id -> "Helper 1"
    const userMsgs = new Set();     // ids of the prompts (opencode echoes them back as parts)
    let main = null, error = null, idle = false, helpers = 0, retrying = false;
    const parts = new Map();        // part id -> { type, text, session }
    let thinkAll = "", answerText = "", answerPart = null;
    const seenTools = new Set();
    let onIdle = null;
    const idleWait = new Promise((r) => { onIdle = r; });

    const handle = async (e) => {
      const p = e.properties || {};
      const sid = p.sessionID || (p.part && p.part.sessionID) || (p.info && p.info.sessionID);
      if (e.type === "session.created" && p.info && p.info.parentID && sessions.has(p.info.parentID)) {
        const label = `Helper ${++helpers}`;
        sessions.set(p.info.id, helperView(view, label));
        labels.set(p.info.id, label);
        return;
      }
      if (!sid || !sessions.has(sid)) return;
      const v = sessions.get(sid) || view;
      const isMain = sid === main;
      const tag = (label) => (isMain ? label : `${labels.get(sid)}: ${label}`);
      switch (e.type) {
        case "message.updated":
          if (p.info && p.info.role === "user") userMsgs.add(p.info.id);
          return;
        case "message.part.updated": {
          const part = p.part;
          if (userMsgs.has(part.messageID)) return;      // the prompt itself
          if (part.type === "step-start") { if (isMain) { view.waiting(model); thinkAll = ""; } return; }
          if (part.type === "reasoning" || part.type === "text") {
            const known = parts.get(part.id);
            parts.set(part.id, { type: part.type, text: part.text || "", session: sid });
            if (part.type === "text" && isMain && !known) {
              if (answerPart && answerText) view.dropAnswer();
              answerPart = part.id; answerText = part.text || "";
            }
            if (part.time && part.time.end && part.type === "reasoning" && part.text) {
              const secs = Math.max(1, Math.round((part.time.end - part.time.start) / 1000));
              v.addStep({ icon: "think", label: tag(`Thought for ${secs < 60 ? secs + "s" : Math.floor(secs / 60) + "m " + String(secs % 60).padStart(2, "0") + "s"}`), detail: part.text });
            }
            return;
          }
          if (part.type !== "tool") return;
          const [name, args] = shape(part.tool, part.state.input, ws);
          const st = part.state;
          if (st.status === "pending") {
            if (isMain && answerText) { view.addStep({ icon: "note", label: thoughtSnippet(answerText, 70) || "Planned the next step", detail: answerText }); view.dropAnswer(); answerText = ""; answerPart = null; }
            v.forming(name === "todowrite" ? "update_plan" : name, st.raw || "");
            return;
          }
          if (st.status === "running") {
            if (!seenTools.has(part.id + ":run")) { seenTools.add(part.id + ":run"); if (name !== "todowrite") v.running(name, args); }
            const out = st.metadata && st.metadata.output;
            if (name === "bash" && out) v.progress(`${describe(name, args, false)} · ${String(out).trim().split("\n").pop().slice(0, 60)}`);
            return;
          }
          if ((st.status === "completed" || st.status === "error") && !seenTools.has(part.id)) {
            seenTools.add(part.id);
            if (name === "todowrite" && st.status === "completed") return;
            const failed = st.status === "error" || (name === "bash" && st.metadata && st.metadata.exit && st.metadata.exit !== 0) || /^Error/.test(String(st.output || ""));
            const image = me.images.get(part.tool.replace(/^mygpt_/, "") + JSON.stringify(part.state.input)) || null;
            v.addStep({ icon: name, label: tag(describe(name, args, true) + (failed ? " (hit an error)" : "")), detail: toolDetail(name, args, st), image });
          }
          return;
        }
        case "message.part.delta": {
          const known = parts.get(p.partID);
          if (!known || p.field !== "text") return;
          known.text += p.delta || "";
          if (known.type === "reasoning") {
            if (isMain) { thinkAll += p.delta || ""; view.thinking(thinkAll, (p.delta || "").length); } else v.thinking(known.text, (p.delta || "").length);
          } else if (isMain && p.partID === answerPart) {
            answerText = known.text;
            view.answer(answerText, (p.delta || "").length);
          } else v.feed((p.delta || "").length);
          return;
        }
        case "todo.updated":
          if (isMain) view.plan((p.todos || []).map((t) => ({ text: String(t.content || "").slice(0, 120), status: PLAN_STATUS[t.status] || "pending" })));
          return;
        case "permission.asked": {
          const cmd = (p.metadata && p.metadata.command) || (p.patterns || []).join("\n");
          let yes = false;
          if (p.permission === "bash") yes = await job.ask("code", cmd);
          await oc(`/permission/${p.id}/reply`, { method: "POST", directory: ws, body: { reply: yes ? "once" : "reject", ...(yes ? {} : { message: "The user declined to run this. Try another way or explain what you need." }) } }).catch(() => {});
          return;
        }
        case "session.status":
          if (isMain && p.status && p.status.type === "retry") {
            retrying = true;
            view.progress(`${PROVIDERS[pid].name} is busy or limiting requests; opencode will try again${p.status.attempt ? ` (attempt ${p.status.attempt})` : ""}`);
          } else if (isMain && retrying && p.status && p.status.type === "busy") retrying = false;
          return;
        case "session.error":
          if (isMain) {
            const er = p.error || {};
            error = (er.data && (er.data.message || er.data.responseBody)) || er.message || er.name || "opencode hit an error";
          }
          return;
        case "session.idle":
          if (isMain) { idle = true; onIdle(); }
          return;
      }
    };
    const pump = (async () => {
      const reader = evRes.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
            if (!data) continue;
            let ev;
            try { ev = JSON.parse(data); } catch (_) { continue; }
            try { await handle(ev); } catch (err) { log(`[opencode] event error: ${err.message}`); }
          }
        }
      } catch (_) { /* closed */ }
      onIdle();
    })();

    const stop = () => { if (main) oc(`/session/${main}/abort`, { method: "POST", directory: ws }).catch(() => {}); };
    job.signal.addEventListener("abort", stop, { once: true });
    try {
      view.waiting(model);
      const ses = await oc("/session", { method: "POST", directory: ws, body: { title: String(text || "myGPT job").slice(0, 80) } });
      main = ses.id;
      sessions.set(main, null);
      await oc(`/session/${main}/prompt_async`, { method: "POST", directory: ws, body: {
        model: { providerID: `mygpt-${pid}`, modelID: model },
        system: systemText(ctx, history),
        tools: { question: false, webfetch: false },
        parts: [{ type: "text", text: userText }],
      } });
      if (job.signal.aborted) stop();
      await idleWait;
      if (!idle && !job.signal.aborted) error = error || "Lost touch with opencode.";

      // the final answer: the text of opencode's last message
      let answer = "";
      try {
        const msgs = await oc(`/session/${main}/message`, { directory: ws });
        const last = [...(msgs || [])].reverse().find((m) => m.info && m.info.role === "assistant");
        answer = last ? last.parts.filter((x) => x.type === "text" && !x.synthetic).map((x) => x.text).join("\n\n").trim() : "";
        const cost = (msgs || []).reduce((n, m) => n + ((m.info && m.info.cost) || 0), 0);
        if (cost > 0) turn.cost = cost;
      } catch (_) { answer = answerText; }

      if (job.signal.aborted) {
        const partial = answer || answerText;
        history.push(turnMsg, { role: "assistant", content: partial ? partial + "\n\n(The user stopped this reply.)" : "(The user stopped this request.)" });
        return finish({ text: partial, stopped: true }, history);
      }
      if (error && !answer) return finish({ kind: "error", text: friendly(error, pid), retry: text, retryFiles: attached.length ? attached : undefined }, job.history);

      let debated = null;
      if (job.settings.debate && KEYS[pid]) {
        // a second model reviews the answer (myGPT's debate, run by the built-in harness)
        view.addStep({ icon: "note", label: `${modelName(model)} drafted an answer`, detail: answer });
        const work = turn.steps.filter((s) => s.icon !== "think").map((s) => `- ${s.label}`).join("\n");
        ctx.history = [...history, turnMsg, { role: "assistant", content: `(Work done with opencode)\n${work}` }];
        debated = await jobStore.run(ctx, () => debate({ question: text || userText, draft: answer, turnMsg, madeFiles: changedFiles(), view, signal: job.signal }));
        answer = debated.text;
        view.writingFinal();
      } else {
        view.answer(answer, 0);
      }
      history.push(turnMsg, { role: "assistant", content: answer || "(It finished without saying anything.)" });
      return finish({ text: answer || "(It finished without saying anything. Try rephrasing.)", debate: debated && { with: debated.with, rounds: debated.rounds, agreed: debated.agreed } }, history);
    } catch (e) {
      if (job.signal.aborted) {
        history.push(turnMsg, { role: "assistant", content: "(The user stopped this request.)" });
        return finish({ text: answerText, stopped: true }, history);
      }
      return finish({ kind: "error", text: friendly(e.message, pid), retry: text, retryFiles: attached.length ? attached : undefined }, job.history);
    } finally {
      job.signal.removeEventListener("abort", stop);
      evCtrl.abort();
      await pump.catch(() => {});
      active.delete(job.id);
      for (const c of me.calls.values()) c.abort();
      // free opencode's memory for this folder; it still grows a little with each job, so restart it
      // between jobs once it's big (the next job starts it again in about 3 seconds)
      await oc("/instance/dispose", { method: "POST", directory: ws }).catch(() => {});
      try { fs.unlinkSync(path.join(jobDir, "opencode.json")); } catch (_) { /* already gone */ }
      if (!active.size && proc && rssMB() > RECYCLE_MB) { log(`[opencode] using ${Math.round(rssMB())} MB; restarting it to free memory`); const old = proc; proc = null; ready = null; old.kill(); }
    }
  }
  function friendly(msg, pid) {
    const m = String(msg || "");
    if (/401|unauthor|invalid api key|rejected the key/i.test(m)) return `${PROVIDERS[pid].name} rejected the server's key. Check it in your host's settings.`;
    if (/402|insufficient|credit/i.test(m)) return `Your ${PROVIDERS[pid].name} account is out of credit. Top up, or pick a cheaper model in Settings.`;
    if (/model.*not found|ModelNotFound|model_not_found/i.test(m)) return `${PROVIDERS[pid].name} doesn't know that model, or it can't use tools. Pick another model in Settings.`;
    return `opencode hit a problem: ${m.slice(0, 400)}`;
  }

  return {
    enabled, why, mode,
    get version() { return version; },
    info: () => ({ brain: enabled ? "opencode" : "builtin", opencode: version || undefined, brainNote: enabled ? undefined : why, memoryMB: Math.round(limit / 2 ** 20) }),
    start: () => (enabled ? ensure() : Promise.resolve()),
    runJob,
    // routes opencode calls back into: /llm/<provider>/v1/... and /mcp/<job>
    async route(req, res, pathname) {
      let m;
      if ((m = pathname.match(/^\/llm\/(openrouter|uberllm)\/v1(\/.*)$/))) { await proxy(req, res, m[1], m[2] + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")); return true; }
      if ((m = pathname.match(/^\/mcp\/([\w-]+)$/))) { await mcp(req, res, m[1]); return true; }
      return false;
    },
    stop() { if (proc) proc.kill(); },
  };
}
