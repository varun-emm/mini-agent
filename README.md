# Mini Agent

A tiny AI agent that runs in your browser on [Groq](https://groq.com) or [OpenRouter](https://openrouter.ai). It thinks, uses tools, checks its work, and loops until the job is done, while a pink blob makes faces at you.

**Open it:** https://varun-emm.github.io/mini-agent/ (after the one-time setup below)

## What it can do

| Tool | What it does |
|---|---|
| Web search | Groq: its `groq/compound-mini` model, which has search built in. OpenRouter: its `web` plugin (a small extra fee per search) |
| Read a web page | Reads one URL in detail |
| Calculator | Exact maths, so the model never guesses numbers |
| Python | Runs real Python in your browser with [Pyodide](https://pyodide.org) (numpy and pandas work). Asks before running |
| Files | Writes, reads and lists files. Download them from Settings |
| Time | Knows today's date |

Tap **See how it got there** under any answer to see every thought, tool call and result.

## One-time setup

1. **Turn on GitHub Pages:** in this repo, go to **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, choose branch **main** and folder **/ (root)**, then tap **Save**. After about a minute, the app is live at the link above.
2. **Get a key** from either provider:
   - Groq (free tier, very fast): https://console.groq.com/keys. Keys start with `gsk_`.
   - OpenRouter (hundreds of models, including Claude and GPT, pay as you go): https://openrouter.ai/settings/keys. Keys start with `sk-or-`.
3. **Open the app** and paste your key. It works out which provider the key belongs to. The key is saved only in that browser, never in this repo.

You can save both keys and switch between them in **Settings → Provider**. Each provider remembers its own model.

## Choosing a model

| Provider | Suggested model | Notes |
|---|---|---|
| Groq | `openai/gpt-oss-120b` | Default. Fast, and covered by the free tier |
| OpenRouter | `openai/gpt-oss-120b` | Default. Costs fractions of a cent per question |
| OpenRouter | `anthropic/claude-sonnet-5.5` | Noticeably smarter at multi-step jobs, and costs more |

On OpenRouter, any model that supports tool calling works. Filter by "Tools" at https://openrouter.ai/models.

## If it says "Couldn't reach Groq"

Some APIs refuse calls made directly from a web page (this is called CORS). OpenRouter allows them, so the easiest fix is to switch to an OpenRouter key. To stay on Groq, deploy the included relay for free:

1. Sign in at https://vercel.com with GitHub, choose **Add New → Project**, and import `mini-agent`. Leave every setting as it is and deploy.
2. Open your new `https://<something>.vercel.app` link. That copy uses the relay automatically.
3. Or keep using GitHub Pages: paste `https://<something>.vercel.app/api/chat` into **Settings → Groq relay**.

The relay (`api/chat.js`) only forwards your own key to Groq. It stores nothing, holds no key of its own, and only accepts requests from `varun-emm.github.io` or its own site. To allow other sites, set an `ALLOWED_ORIGINS` environment variable in Vercel, as a comma-separated list.

## How it works

The model only ever writes text. `app.js` is the **harness** around it:

1. **Think:** send the chat, a system prompt and the tool menu to the model (Groq or OpenRouter).
2. **Act:** if the reply asks for a tool, run that tool in the browser.
3. **Observe:** add the tool's result to the conversation.
4. **Check:** repeat until the model answers without asking for a tool, with a limit of 15 steps.

| Concept | Where it lives |
|---|---|
| Agent loop | `runTurn()` in `app.js` |
| Providers | `PROVIDERS` and `callLLM()` (both speak the same OpenAI-style API) |
| Tool definitions | `TOOLS` (each description tells the model *when* to use the tool) |
| Tool code | `TOOL_FUNCTIONS` |
| System prompt | `systemPrompt()` |
| Context management | `trimHistory()` drops the oldest turns when the chat gets long |
| Error recovery | tool errors go back to the model, and malformed tool calls are retried |
| Human approval | the "Run this Python?" dialog |
| The blob's moods and lines | `LINES`, `TOOL_LINES` in `app.js`, plus the animations in `styles.css` |

## Make it yours

- **Add a tool:** write an async function in `TOOL_FUNCTIONS`, then describe it in `TOOLS`. That's all an "integration" is.
- **More silly lines:** add to `LINES` and `TOOL_LINES` in `app.js`.
- **Different brain:** change the provider or model in Settings. Any model ID that supports tools works.
- **Another provider:** any OpenAI-compatible API can be added as one more entry in `PROVIDERS`.

## Command-line version

`cli/agent.py` is the same agent as a Python terminal app (Groq only):

```
pip install groq ddgs requests
export GROQ_API_KEY="gsk_..."
python cli/agent.py
```

## Safety notes

- Your key lives in your browser's local storage. Use **Settings → Forget my key** on shared devices.
- Set a spend limit in the Groq console, or a credit limit on your OpenRouter key. Agent loops use more tokens than plain chat.
- Python runs inside a sandbox in your browser and can only touch the agent's own files.
