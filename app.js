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
    models: [["openai/gpt-oss-120b", "Smartest"], ["openai/gpt-oss-20b", "Fastest"], ["qwen/qwen3.8-27b", "Preview"]],
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    keyPrefix: "sk-or-",
    keyLink: "https://openrouter.ai/settings/keys",
    defaultModel: "openai/gpt-oss-120b",
    searchModel: "openai/gpt-oss-120b",         // cheap model + OpenRouter's "web" plugin
    models: [["openai/gpt-oss-120b", "Cheap and capable"], ["anthropic/claude-sonnet-5.5", "Smarter, costs more"]],
  },
};
const GROQ_URL = PROVIDERS.groq.url;
const MAX_STEPS = 15;
const MAX_TOOL_OUTPUT = 6000;
const MAX_HISTORY_CHARS = 60000;

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
    autoRun: false,
    relayUrl: "",
  };
  // settings saved by the first version (one Groq key + one model)
  if (typeof saved.apiKey === "string") s.keys.groq = saved.apiKey;
  if (typeof saved.model === "string" && saved.model) s.models.groq = saved.model;
  if (PROVIDERS[saved.provider]) s.provider = saved.provider;
  Object.assign(s.keys, saved.keys || {});
  Object.assign(s.models, saved.models || {});
  if (typeof saved.autoRun === "boolean") s.autoRun = saved.autoRun;
  if (typeof saved.relayUrl === "string") s.relayUrl = saved.relayUrl;
  if (!s.keys[s.provider]) {   // land on whichever provider actually has a key
    const withKey = Object.keys(PROVIDERS).find((p) => s.keys[p]);
    if (withKey) s.provider = withKey;
  }
  return s;
}

// Guess the provider from what a key looks like.
function detectProvider(key) {
  if (key.startsWith(PROVIDERS.openrouter.keyPrefix)) return "openrouter";
  if (key.startsWith(PROVIDERS.groq.keyPrefix)) return "groq";
  return null;
}

const state = {
  settings: loadSettings(),
  history: store.get("ma.history", []),   // what the model sees (without the system prompt)
  log: store.get("ma.log", []),           // what the chat shows
  files: store.get("ma.files", {}),       // the agent's workspace
  running: false,
  abort: null,
};

const provider = () => PROVIDERS[state.settings.provider];
const apiKey = () => state.settings.keys[state.settings.provider] || "";
const currentModel = () => state.settings.models[state.settings.provider] || provider().defaultModel;

const save = {
  settings: () => store.set("ma.settings", state.settings),
  chat: () => { store.set("ma.history", state.history); store.set("ma.log", state.log); },
  files: () => {
    if (!store.set("ma.files", state.files)) toastError("Browser storage is full, so the newest files won't survive a refresh.");
  },
};

// ---------------------------------------------------------------------------
// The blob: phases, mouths, and deeply unserious status lines
// ---------------------------------------------------------------------------
const LINES = {
  idle: [
    "Poke me with a question.",
    "I'm a blob with tools. Ask me stuff.",
    "Awaiting orders, captain.",
    "I contain multitudes. Mostly jelly.",
  ],
  thinking: [
    "Consulting the council of hamsters…",
    "Rotating my brain 90 degrees…",
    "Microwaving thoughts on high…",
    "Bribing neurons with biscuits…",
    "Untangling spaghetti logic…",
    "Asking my imaginary friend Gary…",
    "Defragmenting my vibes…",
    "Loading opinions.exe…",
    "Doing maths with my toes…",
    "Having a small existential crisis…",
    "Petting the GPU for luck…",
    "Arguing with myself. I'm winning.",
    "Chai break for the neurons…",
    "Summoning the ancient autocomplete…",
    "Thinking so hard my antenna is smoking…",
    "Shaking the magic 8-ball politely…",
  ],
  patience: [
    "Still here. The hamsters unionised.",
    "This one's chewy. Hold on.",
    "Gary is being difficult today.",
    "My brain is buffering. Classic.",
  ],
  observing: [
    "Sniffing the results…",
    "Hmm. Interesting. Suspicious, even.",
    "Reading this with one eye closed…",
    "Chewing on the data…",
    "Squinting like a detective…",
    "Checking if the answer is lying to me…",
  ],
  done: [
    "Ta-da. Please clap.",
    "Done! I'd like a biscuit now.",
    "Finished. Rate me five bananas.",
    "Nailed it. Probably. I checked.",
  ],
  error: [
    "I have melted. Details below.",
    "Oops. Brain fell out.",
    "Something went sideways.",
  ],
  stopped: ["Okay okay, I stopped.", "Halted mid-wobble."],
};

const TOOL_LINES = {
  web_search: ["Yelling into the internet…", "Rummaging through the web's junk drawer…", "Googling like a confused uncle…"],
  fetch_webpage: ["Licking the webpage to see how it tastes…", "Speed-reading at 900 words a blink…"],
  calculator: ["Counting on all eleven fingers…", "Abacus go brrr…", "Carrying the one. Dropped it. Got it."],
  run_python: ["Poking the python with a stick…", "Feeding code to the snake…", "Hoping the snake is friendly…"],
  write_file: ["Scribbling on a digital napkin…", "Writing it down before I forget…"],
  read_file: ["Squinting at the file…", "Reading the fine print…"],
  list_files: ["Rummaging through my backpack…"],
  get_current_time: ["Asking the sundial…", "Licking a finger, checking the wind…"],
  harness: ["Re-asking myself, but nicer…"],
};

const MOUTHS = {
  idle: "M56 92 Q66 100 76 92",
  thinking: "M54 94 Q59 89 64 94 Q69 99 74 94 Q77 91 79 93",
  acting: "M55 93 L77 93",
  observing: "M62 93 Q66 89 70 93 Q66 97 62 93",
  done: "M52 88 Q66 106 80 88 Z",
  error: "M54 98 Q66 88 78 98",
  stopped: "M56 94 Q66 92 76 95",
};

const ui = {
  stage: document.getElementById("stage"),
  speech: document.getElementById("speech"),
  mouth: document.getElementById("mouth"),
  chat: document.getElementById("chat"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("sendBtn"),
};

const blob = {
  timer: null, settleTimer: null, phase: "idle", since: 0, last: "",
  pick(pool) {
    const options = pool.filter((l) => l !== this.last);
    const line = options[Math.floor(Math.random() * options.length)] || pool[0];
    this.last = line;
    return line;
  },
  say(text) {
    ui.speech.textContent = text;
    ui.speech.classList.remove("pop");
    void ui.speech.offsetWidth;   // restart the pop animation
    ui.speech.classList.add("pop");
  },
  set(phase, tool) {
    clearInterval(this.timer);
    clearTimeout(this.settleTimer);
    this.phase = phase;
    this.since = Date.now();
    const visual = phase === "stopped" ? "idle" : phase;
    ui.stage.dataset.phase = visual;
    ui.mouth.setAttribute("d", MOUTHS[phase] || MOUTHS.idle);
    const pool = phase === "acting" ? (TOOL_LINES[tool] || LINES.thinking) : (LINES[phase] || LINES.idle);
    this.say(this.pick(pool));
    if (["thinking", "acting", "observing"].includes(phase)) {
      this.timer = setInterval(() => {
        const slow = phase === "thinking" && Date.now() - this.since > 9000;
        this.say(this.pick(slow ? LINES.patience.concat(pool) : pool));
      }, 2300);
    }
    if (phase === "done" || phase === "stopped") {
      this.settleTimer = setTimeout(() => { if (!state.running) this.set("idle"); }, 5000);
    }
  },
};

// ---------------------------------------------------------------------------
// Talking to Groq
// ---------------------------------------------------------------------------
class AgentError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function endpoint() {
  if (state.settings.provider === "openrouter") return PROVIDERS.openrouter.url;   // OpenRouter allows browser calls
  if (state.settings.relayUrl) return state.settings.relayUrl.trim();
  if (location.hostname.endsWith(".vercel.app")) return "/api/chat";   // deployed with the relay
  return GROQ_URL;
}

async function callLLM(body, signal) {
  const name = provider().name;
  let res;
  try {
    res = await fetch(endpoint(), {
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
    throw new AgentError(
      "Couldn't reach Groq from this page. Either you're offline, or Groq is blocking calls made directly from a browser. " +
      "Fix: switch to an OpenRouter key in Settings, or set up the free relay described in the README.", "network");
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  const err = (data && data.error) || null;
  if (!res.ok || err) {
    const e = err || {};
    const code = typeof e.code === "string" ? e.code : "";
    const status = res.ok ? Number(e.code) || 500 : res.status;
    if (code === "tool_use_failed") throw new AgentError(e.message || "Malformed tool call", "tool_use_failed");
    if (status === 401) throw new AgentError(`${name} rejected the API key. Check it in Settings.`, "auth");
    if (status === 402) throw new AgentError(`Your ${name} account is out of credits. Top up, or pick a cheaper model in Settings.`, "credits");
    if (status === 429) throw new AgentError(`${name}'s rate limit was hit. Wait a minute, then try again.`, "rate");
    if (status === 404 && /model/i.test(e.message || "")) {
      throw new AgentError(`${name} doesn't recognise the model "${body.model}", or it can't use tools. Pick another model in Settings.`, "model");
    }
    throw new AgentError(`${name} returned an error (${status}): ${e.message || res.statusText}`, code || "http");
  }
  if (!data || !Array.isArray(data.choices) || !data.choices[0]) {
    throw new AgentError(`${name} sent back an empty reply. Try again.`, "empty");
  }
  return data;
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
  if (!parts.length || parts.includes("..")) throw new Error("Use a simple file name inside the workspace, like notes/report.md");
  return parts.join("/");
}

// Web access: Groq uses its "compound" model (search built in); OpenRouter uses its "web" plugin.
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
  for (const t of msg.executed_tools || []) {             // Groq
    const results = (t.search_results && t.search_results.results) || [];
    for (const r of results) if (r.url) urls.add(r.url);
  }
  for (const a of msg.annotations || []) {                // OpenRouter
    if (a.type === "url_citation" && a.url_citation && a.url_citation.url) urls.add(a.url_citation.url);
  }
  if (urls.size) text += "\n\nSources:\n" + [...urls].slice(0, 8).map((u) => "- " + u).join("\n");
  return text || "No results.";
}

function calculate(expression) {
  let s = String(expression).replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^");
  if (!/[a-z]/i.test(s)) s = s.replace(/,/g, "");   // 1,25,000 -> 125000 (only when no functions)
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
    this.worker = new Worker("py-worker.js");
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (p) { this.pending.delete(e.data.id); p.resolve(e.data); }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.resolve({ ok: false, error: e.message || "Worker crashed" });
      this.pending.clear();
    };
  },
  kill() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.resolve({ ok: false, error: "Stopped." });
    this.pending.clear();
  },
  run(code, timeoutMs) {
    if (!this.worker) this.start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        resolve({ ok: false, error: `Stopped after ${Math.round(timeoutMs / 1000)} seconds (too slow or stuck in a loop).` });
      }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
      this.worker.postMessage({ id, code, files: state.files });
    });
  },
};

function approveCode(code) {
  if (state.settings.autoRun) return Promise.resolve(true);
  const dlg = document.getElementById("approve");
  document.getElementById("approveCode").textContent = code;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

const TOOL_FUNCTIONS = {
  async web_search({ query }, signal) {
    if (!query) throw new Error("query is required");
    return askWeb(`Search the web and answer concisely and factually. Include specific numbers and dates, and list the source URLs you used.\n\nQuery: ${query}`, signal);
  },
  async fetch_webpage({ url }, signal) {
    let host;
    try { host = new URL(url).hostname; } catch (_) { host = ""; }
    if (!/^https?:\/\//i.test(url || "") || !host) throw new Error("Give a full URL starting with http:// or https://");
    return askWeb(`Visit this exact page and report its main content in detail: key facts, numbers, names and dates. Don't add anything that isn't on the page.\n\nURL: ${url}`, signal, host);
  },
  async calculator({ expression }) { return calculate(expression); },
  async run_python({ code }) {
    if (!code) throw new Error("code is required");
    if (!(await approveCode(code))) return "The user declined to run this code. Ask them, or try another approach.";
    if (!python.warmed) blob.say("Downloading an entire Python into your browser. One time only…");
    const r = await python.run(code, python.warmed ? 60000 : 180000);
    if (!r.ok) return "Error: " + r.error;
    python.warmed = true;
    const before = JSON.stringify(state.files);
    state.files = r.files || {};
    if (JSON.stringify(state.files) !== before) { save.files(); renderFiles(); }
    return `exit code: ${r.exit}\nstdout:\n${r.out}\nstderr:\n${r.err}`;
  },
  async write_file({ path, content }) {
    const p = cleanPath(path);
    state.files[p] = String(content ?? "");
    save.files(); renderFiles();
    return `Wrote ${state.files[p].length} characters to ${p}`;
  },
  async read_file({ path }) {
    const p = cleanPath(path);
    if (!(p in state.files)) throw new Error(`No file called ${p}. Use list_files to see what exists.`);
    return state.files[p];
  },
  async list_files() {
    const names = Object.keys(state.files).sort();
    return names.length ? names.map((n) => `${n} (${state.files[n].length} chars)`).join("\n") : "(workspace is empty)";
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
  tool("run_python", "Run Python code (in the user's browser, no internet access; numpy and pandas work). The working folder holds the workspace files. Print anything you need to see. Use for data work, multi-step calculations, or testing code.",
    { code: { type: "string" } }, ["code"]),
  tool("write_file", "Create or overwrite a text file in the workspace. The user can download it from Settings.",
    { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  tool("read_file", "Read a text file from the workspace.", { path: { type: "string" } }, ["path"]),
  tool("list_files", "List the files in the workspace."),
  tool("get_current_time", "Get the user's current local date and time."),
];

const TOOL_LABELS = {
  web_search: ["🔎", "Searched the web"], fetch_webpage: ["📄", "Read a web page"],
  calculator: ["🧮", "Did some maths"], run_python: ["🐍", "Ran Python"],
  write_file: ["✏️", "Wrote a file"], read_file: ["👓", "Read a file"],
  list_files: ["🗂️", "Checked its files"], get_current_time: ["⏰", "Checked the time"],
};

async function executeTool(name, rawArgs, signal) {
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
    return truncate(await fn(args, signal));
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return `Error while running ${name}: ${e.message}`;   // goes back to the model so it can adapt
  }
}

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
- When you write code or a file, verify it: run it, or read it back, before saying it is done.
- If a tool returns an error, read it, fix your approach, and try again. Don't repeat the exact same failing call.
- Ask the user a question only when you truly cannot proceed without their input.

When finished, give a clear, concise final answer in Markdown. Briefly say what you checked, and list source URLs if you used the web.`;
}

function trimHistory() {
  const size = () => state.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
  while (size() > MAX_HISTORY_CHARS) {
    const userIdx = state.history.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
    if (userIdx.length < 2) break;
    state.history.splice(userIdx[0], userIdx[1] - userIdx[0]);   // drop the oldest whole turn
  }
}

// ---------------------------------------------------------------------------
// THE AGENT LOOP
// ---------------------------------------------------------------------------
async function runTurn(text) {
  trimHistory();
  state.history.push({ role: "user", content: text });
  const entry = { kind: "user", text };
  state.log.push(entry);
  renderEntry(entry);

  const turn = { kind: "agent", text: "", steps: [] };
  const view = renderLiveTrace(turn);
  const addStep = (step) => { turn.steps.push(step); view.update(); };

  state.running = true;
  state.abort = new AbortController();
  const signal = state.abort.signal;
  setRunningUI(true);
  let badCalls = 0;

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      // THINK
      blob.set("thinking");
      let data;
      try {
        data = await callLLM({
          model: currentModel(),
          messages: [{ role: "system", content: systemPrompt() }, ...state.history],
          tools: TOOLS, tool_choice: "auto", temperature: 0.3,
        }, signal);
      } catch (e) {
        if (e.code === "tool_use_failed" && badCalls < 2) {
          badCalls++;
          blob.set("acting", "harness");
          addStep({ type: "note", glyph: "🛟", title: "Fumbled a tool call, retried", detail: e.message });
          state.history.push({ role: "user", content: "[harness note] Your last tool call was malformed and was not run. Retry with valid JSON arguments that match the tool's schema." });
          continue;
        }
        throw e;
      }

      const msg = data.choices[0].message;
      if (msg.reasoning) addStep({ type: "think", glyph: "💭", title: "Thought about it", detail: msg.reasoning });

      // ACT + OBSERVE
      if (msg.tool_calls && msg.tool_calls.length) {
        if (msg.content) addStep({ type: "note", glyph: "🗒️", title: "Left itself a note", detail: msg.content });
        state.history.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });
        for (const tc of msg.tool_calls) {
          const name = tc.function.name;
          const [glyph, label] = TOOL_LABELS[name] || ["🛠️", "Used " + name];
          blob.set("acting", name);
          addStep({ type: "act", glyph, title: label, detail: prettyArgs(tc.function.arguments) });
          const result = await executeTool(name, tc.function.arguments, signal);
          blob.set("observing");
          addStep({ type: "observe", glyph: "👀", title: "Looked at the result", detail: result });
          state.history.push({ role: "tool", tool_call_id: tc.id, content: result });
          await pause(450);   // let the observing face land
        }
        continue;
      }

      // CHECK -> DONE
      turn.text = msg.content || "(It finished without saying anything. Try rephrasing.)";
      state.history.push({ role: "assistant", content: turn.text });
      view.finish();
      blob.set("done");
      return;
    }
    turn.text = `I stopped after ${MAX_STEPS} steps without finishing. Say "continue" to let me keep going.`;
    state.history.push({ role: "assistant", content: turn.text });
    view.finish();
    blob.set("stopped");
  } catch (e) {
    if (e.name === "AbortError") {
      turn.text = "Stopped.";
      state.history.push({ role: "assistant", content: "(The user stopped this request.)" });
      view.finish();
      blob.set("stopped");
    } else {
      turn.kind = "error";
      turn.text = e.message;
      if (state.history.length && state.history[state.history.length - 1].role === "user") state.history.pop();
      view.finish();
      blob.set("error");
    }
  } finally {
    state.running = false;
    state.abort = null;
    setRunningUI(false);
    save.chat();
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function prettyArgs(raw) {
  try {
    const obj = JSON.parse(raw || "{}");
    if (obj.code) return obj.code;
    return Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") || "(no arguments)";
  } catch (_) { return String(raw); }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener"); }
  });
}

function markdown(text) {
  const div = el("div");
  if (window.marked && window.DOMPurify) {
    div.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    div.style.whiteSpace = "pre-wrap";
    div.textContent = text;
  }
  return div;
}

function scrollDown() { ui.chat.scrollTop = ui.chat.scrollHeight; }

function traceNode(steps, live) {
  const details = el("details", { class: "trace" });
  const summary = el("summary");
  const list = el("ol", { class: "steps" });
  details.append(summary, list);
  const fill = (isLive) => {
    const last = steps[steps.length - 1];
    summary.textContent = isLive
      ? (last ? `Working: ${last.title.toLowerCase()}` : "Working…")
      : `See how it got there (${steps.length} step${steps.length === 1 ? "" : "s"})`;
    list.replaceChildren(...steps.map((s) =>
      el("li", { class: "step" },
        el("details", {},
          el("summary", {}, el("span", { class: "glyph", "aria-hidden": "true" }, s.glyph), s.title),
          el("pre", {}, truncate(s.detail || "", 4000))))));
  };
  fill(live);
  return { node: details, fill };
}

function renderEntry(entry) {
  document.querySelector(".welcome")?.remove();
  if (entry.kind === "user") {
    ui.chat.append(el("div", { class: "msg user" }, entry.text));
  } else {
    if (entry.steps && entry.steps.length) ui.chat.append(traceNode(entry.steps, false).node);
    if (entry.kind === "error") {
      ui.chat.append(el("div", { class: "msg error", role: "alert" }, el("strong", {}, "That didn't work. "), entry.text));
    } else {
      const bubble = el("div", { class: "msg agent" });
      bubble.append(...markdown(entry.text).childNodes);
      ui.chat.append(bubble);
    }
  }
  scrollDown();
}

function renderLiveTrace(turn) {
  const t = traceNode(turn.steps, true);
  ui.chat.append(t.node);
  scrollDown();
  return {
    update() { t.fill(true); scrollDown(); },
    finish() {
      t.node.remove();
      state.log.push(turn);
      renderEntry(turn);
    },
  };
}

function renderAll() {
  ui.chat.replaceChildren();
  if (!state.log.length) renderWelcome();
  for (const entry of state.log) renderEntry(entry);
}

const EXAMPLES = [
  "What's India's current repo rate, and what's 18% GST on ₹2,40,000?",
  "Write Python that makes a 12 times table, run it, and save it as table.txt",
  "Find three weird facts about octopuses and double-check each one",
];

function renderWelcome() {
  const card = el("section", { class: "welcome" });
  if (!apiKey()) {
    const input = el("input", { type: "password", placeholder: "gsk_... or sk-or-...", "aria-label": "Groq or OpenRouter API key", spellcheck: "false", autocapitalize: "off" });
    const error = el("p", { class: "field-error", role: "alert" });
    const saveKey = () => {
      const v = input.value.trim();
      if (!v) { error.textContent = "Paste a key first."; input.focus(); return; }
      const p = detectProvider(v);
      if (!p) {
        error.textContent = "That doesn't look like a Groq key (gsk_...) or an OpenRouter key (sk-or-...). For anything else, use Settings.";
        input.focus();
        return;
      }
      state.settings.provider = p;
      state.settings.keys[p] = v;
      save.settings(); renderAll(); ui.input.focus();
      blob.say(`${PROVIDERS[p].name} key accepted. Brain online.`);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveKey(); } });
    input.addEventListener("input", () => { error.textContent = ""; });
    const link = (p, text) => el("a", { href: PROVIDERS[p].keyLink, target: "_blank", rel: "noopener" }, text);
    card.append(
      el("h2", {}, "Feed me an API key"),
      el("p", {}, "I'm a blob with tools: web search, a calculator, Python and a notepad. Give me a Groq or OpenRouter key and I'll figure out which it is."),
      el("div", { class: "key-row" }, input, el("button", { class: "primary", type: "button", onclick: saveKey }, "Save key")),
      error,
      el("small", {}, "Your key stays in this browser. Get one from ", link("groq", "Groq"), " (free tier) or ", link("openrouter", "OpenRouter"), "."));
  } else {
    card.append(
      el("h2", {}, "Give me a job"),
      el("p", {}, "Watch my face while I work. Tap a step later to see exactly what I did."),
      el("div", { class: "chips" }, ...EXAMPLES.map((ex) =>
        el("button", { class: "chip", type: "button", onclick: () => submit(ex) }, ex))));
  }
  ui.chat.append(card);
}

function renderFiles() {
  const list = document.getElementById("fileList");
  const names = Object.keys(state.files).sort();
  if (!names.length) { list.replaceChildren(el("li", { class: "empty" }, "Nothing yet. Ask the agent to save something.")); return; }
  list.replaceChildren(...names.map((name) => el("li", {},
    el("span", { class: "name" }, name),
    el("button", { class: "ghost", type: "button", onclick: () => download(name) }, "Download"),
    el("button", { class: "ghost danger", type: "button", "aria-label": `Delete ${name}`, onclick: () => {
      delete state.files[name]; save.files(); renderFiles();
    } }, "Delete"))));
}

function download(name) {
  const url = URL.createObjectURL(new Blob([state.files[name]], { type: "text/plain" }));
  const a = el("a", { href: url, download: name.split("/").pop() });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toastError(text) {
  ui.chat.append(el("div", { class: "msg error", role: "alert" }, el("strong", {}, "Heads up. "), text));
  scrollDown();
}

function setRunningUI(running) {
  ui.send.textContent = running ? "Stop" : "Send";
  ui.send.classList.toggle("stop", running);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function submit(text) {
  text = (text || "").trim();
  if (!text || state.running) return;
  if (!apiKey()) {
    if (state.log.length) { document.getElementById("settingsBtn").click(); return; }
    renderAll(); document.querySelector(".welcome input")?.focus(); return;
  }
  ui.input.value = ""; autosize();
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
function autosize() { ui.input.style.height = "auto"; ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + "px"; }
ui.input.addEventListener("input", autosize);

document.getElementById("newChatBtn").addEventListener("click", () => {
  if (state.running) return;
  state.history = []; state.log = []; save.chat(); renderAll(); blob.set("idle");
});

// settings sheet
const settingsDlg = document.getElementById("settings");
const f = {
  key: document.getElementById("keyInput"), model: document.getElementById("modelInput"),
  autoRun: document.getElementById("autoRunInput"), relay: document.getElementById("relayInput"),
  radios: [...document.querySelectorAll('input[name="provider"]')],
};
// The sheet edits a draft, so switching providers back and forth never loses what you typed.
let draft = null;
const checkedProvider = () => (f.radios.find((r) => r.checked) || {}).value || "groq";

function stashFields() {
  draft.keys[draft.provider] = f.key.value.trim();
  draft.models[draft.provider] = f.model.value.trim();
}
function showProvider(p) {
  draft.provider = p;
  const P = PROVIDERS[p];
  f.radios.forEach((r) => { r.checked = r.value === p; });
  f.key.value = draft.keys[p] || "";
  f.key.placeholder = P.keyPrefix + "...";
  f.model.value = draft.models[p] || P.defaultModel;
  document.getElementById("keyLabel").textContent = `${P.name} API key`;
  document.getElementById("keyDest").textContent = P.name;
  document.getElementById("modelHint").textContent = P.name;
  const link = document.getElementById("keyLink");
  link.href = P.keyLink;
  document.getElementById("models").replaceChildren(...P.models.map(([id, label]) => el("option", { value: id }, label)));
  document.getElementById("relaySection").hidden = p !== "groq";
}

document.getElementById("settingsBtn").addEventListener("click", () => {
  draft = {
    provider: state.settings.provider,
    keys: Object.assign({}, state.settings.keys),
    models: Object.assign({}, state.settings.models),
  };
  f.key.type = "password";
  document.getElementById("toggleKey").textContent = "Show";
  showProvider(draft.provider);
  f.autoRun.checked = state.settings.autoRun;
  f.relay.value = state.settings.relayUrl;
  renderFiles();
  settingsDlg.returnValue = "";
  settingsDlg.showModal();
});
f.radios.forEach((r) => r.addEventListener("change", () => { stashFields(); showProvider(checkedProvider()); }));
f.key.addEventListener("input", () => {   // pasted the other provider's key? switch to it
  const v = f.key.value.trim();
  const p = detectProvider(v);
  if (p && p !== draft.provider) {
    f.key.value = draft.keys[draft.provider] || "";
    stashFields();
    draft.keys[p] = v;
    showProvider(p);
  }
});
document.getElementById("toggleKey").addEventListener("click", (e) => {
  const show = f.key.type === "password";
  f.key.type = show ? "text" : "password";
  e.currentTarget.textContent = show ? "Hide" : "Show";
});
document.getElementById("forgetKey").addEventListener("click", () => {
  const p = draft ? draft.provider : state.settings.provider;
  state.settings.keys[p] = "";
  save.settings(); settingsDlg.close(); renderAll();
  blob.say(`Forgot your ${PROVIDERS[p].name} key. Poof.`);
});
settingsDlg.addEventListener("close", () => {
  if (settingsDlg.returnValue !== "save" || !draft) return;
  stashFields();
  const hadKey = !!apiKey();
  state.settings.provider = draft.provider;
  for (const p of Object.keys(PROVIDERS)) {
    state.settings.keys[p] = draft.keys[p] || "";
    state.settings.models[p] = draft.models[p] || PROVIDERS[p].defaultModel;
  }
  state.settings.autoRun = f.autoRun.checked;
  state.settings.relayUrl = f.relay.value.trim();
  save.settings();
  if (hadKey !== !!apiKey() && !state.log.length) renderAll();
  blob.say(apiKey() ? `Running on ${provider().name}. I feel brand new.` : "No key, no thoughts.");
});
settingsDlg.addEventListener("click", (e) => { if (e.target === settingsDlg) settingsDlg.close(); });

// boot
renderAll();
blob.set("idle");
