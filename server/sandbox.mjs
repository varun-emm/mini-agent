// Server-side tools: running Python, shrinking images, screenshots of files and web pages, and
// turning web pages into text. Python runs as a separate low-privilege user with a bare environment,
// so code the agent writes can't read the server's secrets (your OpenRouter key and password).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON || "python3";
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";
const PYTOOLS = path.join(HERE, "pytools.py");
const FONT_DIR = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"].find((d) => fs.existsSync(d)) || "";

// The low-privilege user Python runs as (created in the Dockerfile). When the server isn't root, Python
// simply runs as the same user.
let sandboxUser = null;
try {
  if (process.getuid && process.getuid() === 0) {
    const uid = Number(execFileSync("id", ["-u", "sandbox"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
    const gid = Number(execFileSync("id", ["-g", "sandbox"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
    if (uid > 0) sandboxUser = { uid, gid };
  }
} catch (_) { /* no sandbox user: run as the server's user */ }

function chownTree(dir) {
  if (!sandboxUser) return;
  try { execFileSync("chown", ["-R", `${sandboxUser.uid}:${sandboxUser.gid}`, dir]); } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
const RUNNER = String.raw`
import os, sys
WS, CODE = sys.argv[1], sys.argv[2]
os.chdir(WS)
os.environ['MPLBACKEND'] = 'Agg'
FONT_DIR = os.environ.get('MA_FONT_DIR', '')
FONT_REGULAR = os.path.join(FONT_DIR, 'DejaVuSans.ttf') if FONT_DIR else None
FONT_BOLD = os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf') if FONT_DIR else None
if FONT_REGULAR and not os.path.exists(FONT_REGULAR): FONT_REGULAR = FONT_BOLD = None
src = open(CODE, encoding='utf-8').read()
if 'matplotlib' in src or 'plt.' in src:
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib.figure import Figure as _F
    _orig = _F.savefig
    def _savefig(self, *a, **k):
        self._ma_saved = True
        return _orig(self, *a, **k)
    _F.savefig = _savefig
g = {'__name__': '__main__', 'FONT_REGULAR': FONT_REGULAR, 'FONT_BOLD': FONT_BOLD}
try:
    exec(compile(src, 'agent.py', 'exec'), g)
finally:
    if 'matplotlib.pyplot' in sys.modules:
        import matplotlib.pyplot as _plt
        for _n in _plt.get_fignums():
            _fig = _plt.figure(_n)
            if not getattr(_fig, '_ma_saved', False) and _fig.axes:
                _i = 1
                while os.path.exists(f'chart_{_i}.png'):
                    _i += 1
                _fig.savefig(f'chart_{_i}.png', dpi=200, bbox_inches='tight')
                print(f'[saved the chart as chart_{_i}.png]')
        _plt.close('all')
`;
const MAX_OUT = 200000;
const PY_TIMEOUT = Number(process.env.PYTHON_TIMEOUT_S || 240) * 1000;
let runCount = 0;

export function runPython(code, workspace, signal, onProgress) {
  return new Promise((resolve) => {
    const jobDir = path.dirname(workspace);
    const n = ++runCount;
    const runner = path.join(jobDir, ".runner.py");
    const codeFile = path.join(jobDir, `.code-${n}.py`);
    const home = path.join(jobDir, ".home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(runner, RUNNER);
    fs.writeFileSync(codeFile, code);
    chownTree(jobDir);
    // a bare environment: nothing from the server's own environment (where the secrets are) is passed on
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", PYTHONUNBUFFERED: "1",
      PYTHONUSERBASE: path.join(home, ".local"), MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(home, ".mpl"),
      MA_FONT_DIR: FONT_DIR, TMPDIR: home,
    };
    if (onProgress) onProgress("Running Python");
    const child = spawn(PY, ["-I", runner, workspace, codeFile], {
      cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      ...(sandboxUser || {}),
    });
    let out = "", err = "", done = false;
    const cap = (s, chunk) => (s.length < MAX_OUT ? s + chunk : s);
    child.stdout.on("data", (d) => { out = cap(out, d.toString()); });
    child.stderr.on("data", (d) => { err = cap(err, d.toString()); });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (_) { try { child.kill("SIGKILL"); } catch (__) { /* gone */ } } };
    const timer = setTimeout(() => { if (!done) { err += `\n[stopped after ${PY_TIMEOUT / 1000} seconds: too slow, or stuck in a loop]`; kill(); } }, PY_TIMEOUT);
    const onAbort = () => { err += "\n[stopped by the user]"; kill(); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { done = true; clearTimeout(timer); resolve({ ok: false, error: `Couldn't start Python: ${e.message}` }); });
    child.on("close", (exitCode) => {
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      try { fs.unlinkSync(codeFile); } catch (_) { /* fine */ }
      if (signal && signal.aborted) { const e = new Error("Stopped"); e.name = "AbortError"; resolve({ ok: false, error: "Stopped." }); return; }
      resolve({ ok: true, exit: exitCode ?? 1, out: out.slice(0, 8000), err: err.slice(-6000) });
    });
  });
}

// ---------------------------------------------------------------------------
// Small trusted helpers (pytools.py): shrink images, turn documents into HTML for screenshots
// ---------------------------------------------------------------------------
function pytool(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [PYTOOLS, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", MPLCONFIGDIR: process.env.MPLCONFIGDIR || "/tmp/.mpl" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error((err.trim().split("\n").pop() || `helper failed (${code})`).slice(0, 300)));
      else resolve(out);
    });
  });
}

// A file as a data URL no bigger than maxSide pixels (JPEG or PNG).
export async function thumbnail(absPath, maxSide = 1100, format = "jpeg") {
  const r = JSON.parse(await pytool(["thumb", absPath, String(maxSide), format]));
  return `data:image/${r.format};base64,${r.b64}`;
}
async function imageShot(absPath, maxW = 1100, maxH = 2400) {
  const r = JSON.parse(await pytool(["shot", absPath, String(maxW), String(maxH)]));
  return { src: `data:image/jpeg;base64,${r.b64}`, width: r.w, height: r.h, cropped: r.cropped };
}

// ---------------------------------------------------------------------------
// Screenshots with Chromium (started for each shot and closed straight after, to save memory)
// ---------------------------------------------------------------------------
let chromium = null;
async function browser() {
  if (!chromium) ({ chromium } = await import("playwright-core"));
  return chromium.launch({
    executablePath: CHROMIUM, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--disable-extensions", "--mute-audio"],
  });
}
export function isPrivateHost(host) {
  if (process.env.ALLOW_PRIVATE_HOSTS === "1") return false;      // tests only
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|metadata\.google\.internal$)/i.test(String(host || ""));
}
async function guard(page) {     // pages may load from the internet, but never from inside the server's network
  await page.route("**/*", (route) => {
    let host = "";
    try { host = new URL(route.request().url()).hostname; } catch (_) { /* data: and the like */ }
    return host && isPrivateHost(host) ? route.abort() : route.continue();
  });
}
async function htmlShot(html, width = 1000, fit = false) {
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
    await guard(page);
    await page.setContent(html, { waitUntil: "load", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    // measure the content itself (the page is at least as big as the window, which would leave empty space)
    const size = await page.evaluate((shrink) => {
      if (shrink) document.body.style.display = "inline-block";   // shrink-wrap tables and charts before measuring
      const kids = [...document.body.children];
      const right = kids.reduce((m, e) => Math.max(m, e.getBoundingClientRect().right), 0);
      const bottom = kids.reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), 0);
      const pad = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
      const box = document.body.getBoundingClientRect();
      return { right: Math.ceil(shrink ? box.right : right + (parseFloat(getComputedStyle(document.body).paddingRight) || 0)), bottom: Math.ceil(bottom + pad) };
    }, fit);
    let w = width;
    if (fit) w = Math.min(width, Math.max(320, size.right));
    const full = Math.max(size.bottom, 120);
    const h = Math.min(2400, Math.max(200, full));
    await page.setViewportSize({ width: w, height: Math.min(h, 2400) });
    const buf = await page.screenshot({ type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: w, height: h } });
    return { src: `data:image/jpeg;base64,${buf.toString("base64")}`, width: w, height: h, cropped: full > 2400 };
  } finally { await b.close().catch(() => {}); }
}
export async function webShot(url, signal) {
  let host = "";
  try { host = new URL(url).hostname; } catch (_) { throw new Error("That isn't a valid web address."); }
  if (isPrivateHost(host)) throw new Error("That address isn't allowed.");
  const b = await browser();
  const stop = () => b.close().catch(() => {});
  if (signal) signal.addEventListener("abort", stop, { once: true });
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await guard(page);
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1500);
    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    const h = Math.min(2400, Math.max(600, full));
    const buf = await page.screenshot({ type: "jpeg", quality: 78, fullPage: full <= 2400, clip: full > 2400 ? { x: 0, y: 0, width: 1280, height: 2400 } : undefined });
    return { src: `data:image/jpeg;base64,${buf.toString("base64")}`, width: 1280, height: h, cropped: full > 2400 };
  } finally {
    if (signal) signal.removeEventListener("abort", stop);
    await stop();
  }
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function pageHTML(inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:28px 34px;background:#fff;color:#111;font:15px/1.5 "DejaVu Sans",Arial,sans-serif}
table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #c8c8c8;padding:5px 9px;text-align:left;vertical-align:top}
th{background:#f2f2f2;font-weight:700}pre{white-space:pre-wrap;font:13px/1.45 "DejaVu Sans Mono",monospace}
img{max-width:100%}h1{font-size:26px}h2{font-size:21px}h3{font-size:17px}.sheet-name{font:600 13px sans-serif;color:#666;margin:0 0 8px}
</style></head><body>${inner}</body></html>`;
}

// A screenshot of a file in the workspace.
export async function fileShot(files, p, pageNo) {
  const abs = files.abs(p);
  const ext = (p.split(".").pop() || "").toLowerCase();
  const n = Math.max(1, Number(pageNo) || 1);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return imageShot(abs);
  if (ext === "svg") return htmlShot(pageHTML(`<img src="data:image/svg+xml;base64,${fs.readFileSync(abs).toString("base64")}">`), 1000, true);
  if (ext === "pdf") {
    const out = path.join(path.dirname(files.dir), `.pdfshot-${Date.now()}`);
    let pages = 0;
    try { pages = Number((execFileSync("pdfinfo", [abs]).toString().match(/Pages:\s+(\d+)/) || [])[1]) || 0; } catch (_) { /* unknown */ }
    if (pages && n > pages) throw new Error(`the PDF has ${pages} page${pages === 1 ? "" : "s"}`);
    execFileSync("pdftoppm", ["-f", String(n), "-l", String(n), "-r", "110", "-jpeg", "-singlefile", abs, out], { timeout: 60000 });
    try {
      const shot = await imageShot(`${out}.jpg`);
      return { ...shot, note: `page ${n}${pages ? ` of ${pages}` : ""}` };
    } finally { fs.rmSync(`${out}.jpg`, { force: true }); }
  }
  if (ext === "pptx") throw new Error("PowerPoint files can't be screenshotted. Check them by reading them with python-pptx.");
  if (["html", "htm"].includes(ext)) return htmlShot(fs.readFileSync(abs, "utf8"), 1000);
  if (ext === "docx") return htmlShot(pageHTML(await pytool(["docx2html", abs])), 900);
  if (["xlsx", "xlsm"].includes(ext)) {
    const r = JSON.parse(await pytool(["xlsx2html", abs, String(n)]));
    const shot = await htmlShot(pageHTML(r.html), 820, true);
    return { ...shot, note: `sheet ${r.index} of ${r.count}: ${r.name}` };
  }
  if (["csv", "tsv"].includes(ext)) return htmlShot(pageHTML(await pytool(["csv2html", abs, ext === "tsv" ? "\t" : ","])), 820, true);
  if (ext === "md") {
    const { marked } = await import("marked");
    return htmlShot(pageHTML(marked.parse(fs.readFileSync(abs, "utf8"))), 900);
  }
  const text = fs.readFileSync(abs, "utf8").slice(0, 60000);
  return htmlShot(pageHTML(`<pre>${esc(text)}</pre>`), 900);
}

// ---------------------------------------------------------------------------
// Web page HTML to readable text
// ---------------------------------------------------------------------------
export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  let t = html
    .replace(/<(script|style|noscript|svg|nav|footer|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|table|ul|ol|header|blockquote|pre)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<[^>]+>/g, " ");
  const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", rupee: "₹" };
  t = t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    try { return e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ent[e.toLowerCase()] ?? m; } catch (_) { return m; }
  });
  t = t.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return (title ? `Title: ${title.trim()}\n\n` : "") + t;
}
