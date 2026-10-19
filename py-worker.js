// Runs Python in the browser with Pyodide, inside a Web Worker so the page never freezes.
// The agent's files are copied into /workspace before each run and copied back (as raw bytes) afterwards,
// so Excel, Word, PDF, PowerPoint and image files survive intact.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.js";
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// import name -> PyPI package (pure-Python wheels that micropip can fetch on first use)
const PYPI = {
  docx: "python-docx",
  pptx: "python-pptx",
  openpyxl: "openpyxl",
  fpdf: "fpdf2",
  xlsxwriter: "xlsxwriter",
  reportlab: "reportlab",
  tabulate: "tabulate",
  qrcode: "qrcode",
  markdown: "markdown",
  docx2txt: "docx2txt",
  pypdf: "pypdf",
};

let ready = null;
const installed = new Set();
let currentId = null;
const progress = (text) => self.postMessage({ id: currentId, progress: text });

function rmrf(fs, path) {
  for (const name of fs.readdir(path)) {
    if (name === "." || name === "..") continue;
    const p = path + "/" + name;
    if (fs.isDir(fs.stat(p).mode)) { rmrf(fs, p); fs.rmdir(p); } else fs.unlink(p);
  }
}

function mkdirs(fs, path) {
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) {
    cur += "/" + part;
    try { fs.mkdir(cur); } catch (_) { /* exists */ }
  }
}

function collect(fs, dir, prefix, out, skipped) {
  for (const name of fs.readdir(dir)) {
    if (name === "." || name === ".." || name === "__pycache__" || name.startsWith(".")) continue;
    const p = dir + "/" + name;
    const st = fs.stat(p);
    if (fs.isDir(st.mode)) collect(fs, p, prefix + name + "/", out, skipped);
    else if (st.size > MAX_FILE_BYTES) skipped.push(prefix + name);
    else out[prefix + name] = fs.readFile(p);   // Uint8Array
  }
}

function packagesFor(code) {
  const names = new Set();
  for (const m of code.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^\s*import\s+([\w\s,.]+)$/gm)) {
    for (const part of m[1].split(",")) names.add(part.trim().split(/[\s.]/)[0]);
  }
  if (/\.(to|read)_excel\s*\(|ExcelWriter/.test(code)) names.add("openpyxl");
  return names;
}

const PRELUDE = `
import os, sys
os.chdir('/workspace')
os.environ['MPLBACKEND'] = 'Agg'
FONT_REGULAR = FONT_BOLD = None
`;

const MPL_SETUP = `
import matplotlib
matplotlib.use('Agg')
from matplotlib.figure import Figure as _MAFigure
if not getattr(_MAFigure, '_ma_patched', False):
    _ma_orig_savefig = _MAFigure.savefig
    def _ma_savefig(self, *a, **k):
        self._ma_saved = True
        return _ma_orig_savefig(self, *a, **k)
    _MAFigure.savefig = _ma_savefig
    _MAFigure._ma_patched = True
import matplotlib.pyplot as _ma_plt
_ma_plt.close('all')
`;

const FONT_SETUP = `
import matplotlib as _ma_mpl, os as _ma_os
_ma_dir = _ma_os.path.join(_ma_mpl.get_data_path(), 'fonts', 'ttf')
FONT_REGULAR = _ma_os.path.join(_ma_dir, 'DejaVuSans.ttf')
FONT_BOLD = _ma_os.path.join(_ma_dir, 'DejaVuSans-Bold.ttf')
if not _ma_os.path.exists(FONT_REGULAR): FONT_REGULAR = None
if not _ma_os.path.exists(FONT_BOLD): FONT_BOLD = FONT_REGULAR
`;

// Charts that were drawn but never saved get saved automatically, like a notebook would show them.
const POSTLUDE = `
if 'matplotlib.pyplot' in sys.modules:
    import matplotlib.pyplot as _ma_plt
    for _ma_num in _ma_plt.get_fignums():
        _ma_fig = _ma_plt.figure(_ma_num)
        if not getattr(_ma_fig, '_ma_saved', False) and _ma_fig.axes:
            _ma_i = 1
            while os.path.exists(f'chart_{_ma_i}.png'):
                _ma_i += 1
            _ma_fig.savefig(f'chart_{_ma_i}.png', dpi=200, bbox_inches='tight')
            print(f'[saved the chart as chart_{_ma_i}.png]')
    _ma_plt.close('all')
`;

self.onmessage = async (event) => {
  const { id, code, files } = event.data;
  currentId = id;
  try {
    if (!ready) {
      progress("Starting Python (first run downloads it, about 10 MB)");
      importScripts(PYODIDE_URL);
      ready = loadPyodide();
    }
    const py = await ready;
    const fs = py.FS;
    let out = "";
    let err = "";
    py.setStdout({ batched: (s) => { out += s + "\n"; } });
    py.setStderr({ batched: (s) => { err += s + "\n"; } });

    mkdirs(fs, "/workspace");
    rmrf(fs, "/workspace");
    for (const [name, bytes] of Object.entries(files || {})) {
      const full = "/workspace/" + name;
      mkdirs(fs, full.substring(0, full.lastIndexOf("/")));
      fs.writeFile(full, bytes);
    }

    let exit = 0;
    try {
      const wanted = packagesFor(code);
      const needsFonts = wanted.has("fpdf") || wanted.has("reportlab");
      const builtin = [...wanted].filter((n) => !PYPI[n]);
      if (needsFonts || wanted.has("matplotlib")) builtin.push("matplotlib");
      progress("Loading Python libraries");
      await py.loadPackagesFromImports(builtin.map((n) => `import ${n}`).join("\n") + "\n" + code);
      const fromPypi = [...new Set([...wanted].filter((n) => PYPI[n]).map((n) => PYPI[n]))].filter((p) => !installed.has(p));
      if (fromPypi.length) {
        await py.loadPackage("micropip");
        const micropip = py.pyimport("micropip");
        for (const pkg of fromPypi) {
          progress(`Installing ${pkg}`);
          await micropip.install(pkg);
          installed.add(pkg);
        }
      }
      await py.runPythonAsync(PRELUDE);
      if (wanted.has("matplotlib") || /\bplt\./.test(code)) await py.runPythonAsync(MPL_SETUP);
      if (needsFonts) await py.runPythonAsync(FONT_SETUP);
      progress("Running Python");
      await py.runPythonAsync(code);
      await py.runPythonAsync(POSTLUDE);
    } catch (e) {
      exit = 1;
      err += String((e && e.message) || e);
    }
    const back = {};
    const skipped = [];
    collect(fs, "/workspace", "", back, skipped);
    if (skipped.length) err += `\n[not kept, larger than 25 MB: ${skipped.join(", ")}]`;
    const buffers = [...new Set(Object.values(back).map((b) => b.buffer))];
    self.postMessage({ id, ok: true, exit, out, err, files: back }, buffers);
  } catch (e) {
    ready = null;
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
