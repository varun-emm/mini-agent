// Optional page reader for the Vercel relay: fetches a web page server-side and returns its readable text,
// so Mini Agent can read pages exactly (browsers can't fetch most sites directly). Stores nothing.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://varun-emm.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BYTES = 3 * 1024 * 1024;

// refuse addresses inside private networks
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

function htmlToText(html) {
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
  t = t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ent[e.toLowerCase()] ?? m);
  t = t.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return (title ? `Title: ${title.trim()}\n\n` : "") + t;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const sameSite = !origin || origin === `https://${req.headers.host}`;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (!sameSite && !ALLOWED_ORIGINS.includes(origin)) return res.status(403).send("This relay doesn't accept requests from " + origin);
  let url;
  try { url = new URL(String(req.query.url || "")); } catch (_) { return res.status(400).send("Give ?url=https://..."); }
  if (!/^https?:$/.test(url.protocol) || PRIVATE.test(url.hostname)) return res.status(400).send("That address isn't allowed.");
  try {
    const page = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MiniAgentReader/1.0)", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      redirect: "follow", signal: AbortSignal.timeout(20000),
    });
    const type = page.headers.get("content-type") || "";
    const buf = Buffer.from(await page.arrayBuffer()).subarray(0, MAX_BYTES);
    const raw = buf.toString("utf8");
    const text = /html|xml/i.test(type) ? htmlToText(raw) : raw;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(page.ok ? 200 : 502).send(page.ok ? text : `The page answered ${page.status}.`);
  } catch (e) {
    return res.status(502).send("Couldn't load the page: " + e.message);
  }
}
