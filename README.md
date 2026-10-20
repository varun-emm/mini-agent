# Mini Agent

A tiny AI agent that runs in your browser on [Groq](https://groq.com) or [OpenRouter](https://openrouter.ai). It thinks, uses tools, checks its work, loops until the job is done, and hands you real files: Excel, Word, PDF, PowerPoint, charts and more.

**Open it:** https://varun-emm.github.io/mini-agent/ (after the one-time setup below)

The version number is shown next to the title. See [CHANGELOG.md](CHANGELOG.md) for what changed in each one.

## What it can do

| Tool | What it does |
|---|---|
| Web search | Groq: its `groq/compound-mini` model, which has search built in. OpenRouter: its `web` plugin (a small extra fee per search) |
| Read a web page | Reads one URL in detail |
| Calculator | Exact maths, so the model never guesses numbers |
| Python | Runs real Python in your browser with [Pyodide](https://pyodide.org). Libraries like openpyxl, python-docx, python-pptx and fpdf2 install by themselves the first time they're used |
| Files | Makes Excel, Word, PDF, PowerPoint, PNG charts, CSV, Markdown, HTML, JSON, code and ZIP files |
| Screenshot | Takes a screenshot of a file it made (chart, PDF, Word, Excel, CSV, HTML) or of a web page, and has a vision model check it |
| Time | Knows today's date |

While it works, replies stream in live, and a line in the chat shows what's actually happening:

- the model's own current thought ("The search says 18% for most goods."), one finished sentence at a time
- the tool call it's writing ("Writing code for gst_summary.xlsx (24 lines)", "Planning a search for…")
- the tool that's running ("Searching the web for…", "Installing python-docx", "Creating gst_summary.xlsx")

The answer flows in paragraph by paragraph, then the line settles into **Worked for 12s**. Tap it to see every step and its output.

The spinner is your animation, and it turns and pulses with the work:

| What's happening | Spin | Pulse | Glow | Colour shift |
|---|---|---|---|---|
| Waiting for the model's first word | slow drift | slow, even breath | blue | barely drifts |
| Thinking | clockwise | breath that quickens as words arrive | violet | slides steadily |
| Searching, reading, looking at a screenshot | counter-clockwise | draws in (shrinks) on each beat | teal | slides backwards |
| Making a file or running code | clockwise, fast | strong double heartbeat | pink | sweeps fastest |
| Writing the answer | clockwise | gentle beat on each burst of words | blue | slides gently |

Its colours slide around the colour wheel (a hue shift) while saturation and transparency stay normal. Speed and colour shift both follow how fast text is arriving, each beat pushes the colours a little further, every finished step gives it a little pop and a quick colour jump, and it eases between moods. When the work is done it swells once and shrinks away.

## It checks its own work

Mini Agent has a **screenshot** tool. After it makes a chart, PDF, Word, Excel, CSV or HTML file, it takes a screenshot and asks a vision model a specific question, such as "Are the axis labels readable?" or "Does the total read ₹10,62,000?". If something's wrong, it fixes the file and checks again. It can also screenshot a web page to see what it looks like.

- You see each screenshot in the steps under the answer. Tap it to view it full size.
- Files are drawn inside the browser: images as they are, PDFs with [pdf.js](https://mozilla.github.io/pdf.js/), and documents and web pages with [html-to-image](https://github.com/bubkoo/html-to-image) inside a sandboxed frame, so a page the agent made can't reach this app or your keys.
- Web pages are captured by [Microlink](https://microlink.io). Without a key it allows about 25 screenshots a day.
- The vision model is set in **Settings → Vision model**: `qwen/qwen3.8-27b` on Groq, and `anthropic/claude-haiku-5.5` on OpenRouter by default.
- PowerPoint files can't be screenshotted. The agent checks those by reading them with python-pptx.

## Debate mode: two AIs check each other

Save both a Groq key and an OpenRouter key, then turn on **Settings → Debate**. Every answer then goes through a debate before you see it:

1. The provider picked in Settings (the **lead**) does the work: searches, code, files. Then it writes a draft.
2. The other provider (the **reviewer**) checks the draft. It can verify facts with web search, redo maths with the calculator, and screenshot or read the files the lead made. Then it says **agree**, or lists what's wrong.
3. The lead weighs each point, fixes what's right (including the files), pushes back on what isn't, and writes a new answer.
4. Steps 2 and 3 repeat until the reviewer agrees, up to 3 rounds. If they still disagree after that, the answer says what they disagree on.

While it runs, a coloured tag in the status line shows whose turn it is. Afterwards the summary says, for example, **Worked for 40s, agreed after 2 rounds**. Tap it to read the whole exchange. The title shows **Groq ⇄ OpenRouter, debating** while it's on.

It's slower and uses more requests from both providers. It works best when the two use different models, such as gpt-oss-120b on Groq and claude-sonnet-5.5 on OpenRouter. If the reviewer can't be reached (no credits, rate limit), you still get the lead's answer, with a note in the steps.

## Chat history

Every conversation is saved on your device. Tap the sidebar button (top left) to see them, grouped by day, with search. **Settings** is at the top of that sidebar, or tap the model name under the title. Tap **Edit** to delete chats. Each chat keeps its own files, and the pencil button (top right) starts a new chat.

## Files

Every file the agent makes shows up under its answer as a card. Charts and images are shown full size.

- **Tap a card** to preview it. Excel sheets, Word documents, PDFs, CSVs, images, Markdown and code all preview in the app. PowerPoint files don't preview, but you can still share or download them.
- **Share** (iPhone and Android) opens the system share sheet: Save to Files, AirDrop, WhatsApp, Mail.
- **Download** saves the file to your device.
- Files are kept on your device (in the browser's storage) between visits, with each chat's files kept separately. Manage them in **Settings → Files in this chat**.

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

Groq's free tier allows only a few requests per minute, and an agent makes several per question. When Groq asks it to slow down, Mini Agent waits the time Groq gives (up to about 45 seconds) and tries again by itself. For longer limits, it tells you when to try again. If you hit this often, use an OpenRouter key.

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
4. **Check:** repeat until the model answers without asking for a tool, with a limit of 20 steps.

| Concept | Where it lives |
|---|---|
| Agent loop | `agentLoop()` in `app.js` (`runTurn()` runs one request) |
| Debate | `debate()`, `reviewerPrompt()`, `readVerdict()` |
| Providers | `PROVIDERS` and `callLLM()` (both speak the same OpenAI-style API) |
| Tool definitions | `TOOLS` (each description tells the model *when* to use the tool) |
| Tool code | `TOOL_FUNCTIONS` |
| System prompt | `systemPrompt()` |
| Context management | `trimHistory()` drops the oldest turns when the chat gets long |
| Error recovery | tool errors go back to the model, and malformed tool calls are retried |
| Streaming | `streamLLM()` reads thinking, answer text and tool calls as they're written |
| Status line | `thoughtSnippet()`, `describeForming()` and `describe()` turn the stream into plain English |
| Motion | `makeLoader()` (spin, pulse and glow), `makeTicker()` (status crossfade), `makeStreamer()` (paced answer reveal) |
| Screenshots | `fileShot()`, `webShot()`, `renderHtmlShot()`, `pdfShot()`, then `lookAt()` asks the vision model |
| Chat history | `chats`, `openChat()`, `renderChatList()` (stored in IndexedDB) |
| File handling | `files` (stored in IndexedDB), `syncFromPython()`, `openPreview()` |
| Python sandbox | `py-worker.js`, which installs libraries and auto-saves unsaved charts |
| Human approval | optional "Run this code?" alert (Settings → Ask before running code) |

## Make it yours

- **Add a tool:** write an async function in `TOOL_FUNCTIONS`, then describe it in `TOOLS`. That's all an "integration" is.
- **Change the status wording:** edit `describe()` in `app.js`.
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
- Python runs inside a sandbox in your browser. It has no internet access and can only touch the agent's own files, so it runs without asking. Turn on **Ask before running code** if you'd rather approve each run.
- The first time Python runs, the browser downloads it (about 10 MB). After that it's cached.
