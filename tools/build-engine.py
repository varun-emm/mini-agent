# Builds server/engine.mjs from the browser app's agent code (copied verbatim), plus server-specific parts.
# Run it after changing the agent in app.js:  python3 tools/build-engine.py
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "app.js")).read()
def cut(start, end):
    i = src.index(start); j = src.index(end, i)
    return src[i:j]
parts = []
parts.append(cut("const PROVIDERS = {", "// ---------------------------------------------------------------------------\n// Settings & chat storage"))
parts.append(cut("const EXT_INFO = {", "function fileUrl("))
parts.append(cut("class AgentError extends Error", "// ---------------------------------------------------------------------------\n// TOOLS"))
parts.append(cut("const truncate = ", "// Python runs in a Web Worker"))
parts.append(cut("// Ask the vision model about a screenshot.", "// Reading a web page: get its real text"))
parts.append(cut("const OR_API = ", "// A helper agent: works on one self-contained task"))
parts.append(cut("// A helper agent: works on one self-contained task", "// ---------------------------------------------------------------------------\n// Plain-English status"))
parts.append(cut("const quote = ", "// One request from the user, start to finish."))
parts.append(cut("// What a helper's work looks like", "// ---------------------------------------------------------------------------\n// Rendering helpers"))
body = "\n".join(parts)

def rep(a, b, n=1):
    global body
    c = body.count(a)
    assert c == n, (c, a[:100])
    body = body.replace(a, b)

# settings that came from the browser
rep('const CONTEXT_CHARS = Number(localStorage.getItem("ma.ctxChars")) || 70000;', 'const CONTEXT_CHARS = Number(process.env.CONTEXT_CHARS) || 70000;')
# rate-limit notices belong to the job that hit them
rep("let rateNotice = null;   // set while a turn runs, so the status line can say what's happening\n", "")
rep("    if (rateNotice) rateNotice(wait, attempt + 1);", "    if (state.rateNotice) state.rateNotice(wait, attempt + 1);")
# the key lives on the server
rep('const orKey = () => state.settings.keys.openrouter || "";', 'const orKey = () => apiKey();')
# images: read from the job's workspace and shrink with Python (no canvas on a server)
i = body.index("async function imageRef(path) {"); j = body.index("const money = ", i)
body = body[:i] + '''async function imageRef(path) {
  const p = cleanPath(path);
  if (!files.has(p)) throw new Error(`No file called ${p}. Use list_files to see what exists.`);
  if (fileInfo(p).kind !== "image") throw new Error(`${p} isn't an image.`);
  return thumbnail(files.abs(p), 1536, fileInfo(p).ext === "png" ? "png" : "jpeg");
}
''' + body[j:]
rep("  if (ctx.onImage) { try { ctx.onImage((await toJpeg(new Blob([bytes], { type: mime }))).src); } catch (_) { /* preview only */ } }",
    "  if (ctx.onImage) { try { ctx.onImage(await thumbnail(files.abs(name), 1100, \"jpeg\")); } catch (_) { /* preview only */ } }")
# the price check before a video is answered from the phone
i = body.index("function confirmVideo(text) {"); j = body.index("async function makeVideo(", i)
body = body[:i] + "const confirmVideo = (text) => state.ask(\"video\", text);\n" + body[j:]
# Python, files and screenshots run on the server
rep('''    const r = await python.run(code, python.warmed ? 90000 : 240000, ctx.onProgress);
    if (!r.ok) return "Error: " + r.error;
    python.warmed = true;
    const { changed, removed } = syncFromPython(r.files, r.sent);''', '''    const before = files.snapshot();
    const r = await runPython(code, files.dir, ctx.signal, ctx.onProgress);
    if (!r.ok) return "Error: " + r.error;
    const after = files.snapshot();
    const changed = [...after.keys()].filter((p) => before.get(p) !== after.get(p));
    const removed = [...before.keys()].filter((p) => !after.has(p));''')
rep('''      shot = await webShot(t);''', '''      shot = await webShot(t, ctx.signal);''')
rep('''      try { shot = await fileShot(p, page); } catch (e)''', '''      try { shot = await fileShot(files, p, page); } catch (e)''')
rep('''    return new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" }) +
      ` (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;''', '''    return new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: state.tz }) + ` (${state.tz})`;''')
# what the model is told about where it runs
rep('''  tool("run_python", "Run Python 3 in the user's browser (no internet). Use it for calculations, data work, and to CREATE FILES: " +''',
    '''  tool("run_python", "Run Python 3 on the server (it has internet access, and requests is installed). Use it for calculations, data work, and to CREATE FILES: " +''')
rep('''  const now = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" });
  return `You are Mini Agent''', '''  const now = new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: state.tz });
  return `You are Mini Agent''')
rep('''Current date and time: ${now} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).''', '''Current date and time: ${now} (${state.tz}).''')
rep('''- Python has no internet access. Get any data you need with web_search first, then put it in the code.''',
    '''- Python runs on a server with internet access, so it can download a data file directly with requests. Still use web_search and fetch_webpage to find and read information.''')
rep('''- For fpdf2 PDFs, use the provided Unicode font so symbols like ₹ work: pdf.add_font("DejaVu", "", FONT_REGULAR); pdf.add_font("DejaVu", "B", FONT_BOLD); pdf.set_font("DejaVu", size=11).''',
    '''- For fpdf2 PDFs, use the provided Unicode font so symbols like ₹ work: pdf.add_font("DejaVu", "", FONT_REGULAR); pdf.add_font("DejaVu", "B", FONT_BOLD); pdf.set_font("DejaVu", size=11). FONT_REGULAR and FONT_BOLD are already defined in your Python.''')
rep('''- To see what a web page looks like, screenshot its URL. The free web screenshot service allows about 25 a day, so use it only when looking matters.''',
    '''- To see what a web page looks like, screenshot its URL. The server is slow, so use it only when looking matters.''')
# helpers and debate reach the job's spawner through the job state
rep("tools: leadTools(), quiet: true, who: L, spawn: debate.spawn });", "tools: leadTools(), quiet: true, who: L, spawn: state.spawn });")
# tests can point the engine at a stand-in for OpenRouter
rep('url: "https://openrouter.ai/api/v1/chat/completions",', 'url: OR_BASE + "/chat/completions",')
rep('const OR_API = "https://openrouter.ai/api/v1";', 'const OR_API = OR_BASE;')
# sizes come from the file system, without reading whole files
body = re.sub(r'files\.get\(([^()]*)\)\.bytes\.length', r'files.get(\1).size', body)
# phone-only pieces that must not be copied
assert "localStorage" not in body, [l for l in body.splitlines() if "localStorage" in l]
assert not re.search(r"\bdocument\.(getElementById|querySelector|createElement)", body)

header = r'''// Mini Agent server engine: the same agent as the browser app (loop, tools, helpers, debate, memory,
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

'''

footer = r'''
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
'''
open(os.path.join(ROOT, "server", "engine.mjs"), "w").write(header + body + footer)
print("engine written:", len(header + body + footer), "chars")
