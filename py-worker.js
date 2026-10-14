// Runs Python in the browser with Pyodide, inside a Web Worker so the page never freezes.
// The agent's files are copied into /workspace before each run and copied back afterwards.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
let ready = null;

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

function collect(fs, dir, prefix, out) {
  for (const name of fs.readdir(dir)) {
    if (name === "." || name === ".." || name.startsWith("_agent_run")) continue;
    const p = dir + "/" + name;
    const st = fs.stat(p);
    if (fs.isDir(st.mode)) collect(fs, p, prefix + name + "/", out);
    else if (st.size <= 1_000_000) {
      try { out[prefix + name] = fs.readFile(p, { encoding: "utf8" }); } catch (_) { /* binary, skip */ }
    }
  }
}

self.onmessage = async (event) => {
  const { id, code, files } = event.data;
  try {
    if (!ready) {
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
    for (const [name, content] of Object.entries(files || {})) {
      const full = "/workspace/" + name;
      mkdirs(fs, full.substring(0, full.lastIndexOf("/")));
      fs.writeFile(full, content);
    }
    py.runPython("import os; os.chdir('/workspace')");

    let exit = 0;
    try {
      await py.loadPackagesFromImports(code);
      await py.runPythonAsync(code);
    } catch (e) {
      exit = 1;
      err += String((e && e.message) || e);
    }
    const back = {};
    collect(fs, "/workspace", "", back);
    self.postMessage({ id, ok: true, exit, out, err, files: back });
  } catch (e) {
    ready = null;
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
