// Optional relay for Vercel. Only needed if Groq blocks calls made straight from the browser (OpenRouter never needs it).
// It forwards the caller's OWN key to Groq and stores nothing. No key lives on this server.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Which web pages may use this relay. Add your own domains if you host the app elsewhere.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://varun-emm.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const sameSite = !origin || origin === `https://${req.headers.host}`;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!sameSite && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: { message: "This relay doesn't accept requests from " + origin } });
  }
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Use POST." } });

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "Missing Groq API key." } });
  }

  const upstream = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
  });
  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  res.send(await upstream.text());
}
