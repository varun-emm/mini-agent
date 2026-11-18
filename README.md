# myGPT

A personal AI agent that runs in your browser on [OpenRouter](https://openrouter.ai) or [UberLLM](https://uberllm.dev) (you pick in Settings). Each gives one key access to Kimi, Claude, GPT and many other models. The default brain is **Kimi K3.1 Pro**. It thinks, uses tools, checks its work, loops until the job is done, and hands you real files: Excel, Word, PDF, PowerPoint, charts and more.

**Open it:** https://varun-emm.github.io/mini-agent/ (after the one-time setup below)

The version number and its name (5.1 is "Novus") are shown next to the title. See [CHANGELOG.md](CHANGELOG.md) for what changed in each one.

## What it can do

| Tool | What it does |
|---|---|
| Web search | On OpenRouter, its `web` plugin (a small extra fee per search). On UberLLM, which has no search, DuckDuckGo results read through Jina Reader; the agent then opens the pages that matter |
| Read a web page | Gets the page's actual text (long pages in parts), through your relay or the free [Jina Reader](https://jina.ai/reader). Falls back to a search model's report if both fail |
| Calculator | Exact maths, so the model never guesses numbers |
| Python | Runs real Python in your browser with [Pyodide](https://pyodide.org). Libraries like openpyxl, python-docx, python-pptx and fpdf2 install by themselves the first time they're used |
| Files | Makes Excel, Word, PDF, PowerPoint, PNG charts, CSV, Markdown, HTML, JSON, code and ZIP files |
| Screenshot | Takes a screenshot of a file it made (chart, PDF, Word, Excel, CSV, HTML) or of a web page, and has a vision model check it |
| Time | Knows today's date |
| Plan | Shows its plan for a multi-step job as a live checklist |
| Helpers | Hands independent parts of a big job to helper agents that work at the same time |
| Memory | Saves short facts you tell it (name, business, preferences) and uses them in every chat |
| Pictures | Makes and edits images with an AI image model on your provider (posters, product shots, logos, photos) |
| Video | Makes short AI video clips on your provider, after showing you the price and asking first |

While it works, replies stream in live, and a line in the chat shows what's actually happening:

- the model's own current thought ("The search says 18% for most goods."), one finished sentence at a time
- the tool call it's writing ("Writing code for gst_summary.xlsx (24 lines)", "Planning a search for…")
- the tool that's running ("Searching the web for…", "Installing python-docx", "Creating gst_summary.xlsx")

The answer flows in paragraph by paragraph, then the line settles into **Worked for 12s**. Tap it to see every step and its output.

The look is frosted glass: a soft blue glow drifts slowly behind the app, and the bars, composer, Settings and sidebar are see-through panels that blur what's behind them. Cards and message bubbles use a lighter see-through tint so long chats stay smooth on phones. It follows your phone's light or dark setting.

The spinner is your animation, and it turns and pulses with the work:

| What's happening | Spin | Animation frames | Pulse | Glow | Colour shift |
|---|---|---|---|---|---|
| Waiting for the model's first word | slow drift | 1× (normal speed) | slow, even breath | blue | barely drifts |
| Thinking | clockwise | 2× | breath that quickens as words arrive | violet | slides steadily |
| Searching, reading, looking at a screenshot | counter-clockwise | 3×, backwards | draws in (shrinks) on each beat | teal | slides backwards |
| Making a file or running code | clockwise, fast | 5× | strong double heartbeat | pink | sweeps fastest |
| Writing the answer | clockwise | 2× | gentle beat on each burst of words | blue | slides gently |

The spinner is the rainbow spiral that draws itself (back in v5 after the blue swirl of v4.1). The app plays it frame by frame from a strip of its 60 frames (`assets/loader-frames.webp`), so it controls the speed and direction. It never plays slower than 1× or faster than 5×: text pouring in pushes it up a level, each finished step gives it a burst, and it turns round instantly instead of slowing through a stop. Its colours slide around the colour wheel (a hue shift) while saturation and transparency stay normal. Speed and colour shift both follow how fast text is arriving, each beat pushes the colours a little further, every finished step gives it a little pop and a quick colour jump, and it eases between moods. When the work is done it swells once and shrinks away.

## Look and controls (v5.1)

- **Credit used** shows under the name: on OpenRouter, how much of all the credit you've bought is spent; on UberLLM (which only reports a balance), how much you've used since your last top-up. Hover or long-press for the dollar amounts. It updates after every reply.
- **Brain button** (left of Send): switch between your provider's suggested models in one tap; "More models in Settings" for anything else. It also sets the **step budget**, how many steps the agent may take per request: Thin 10, Light 20, Medium 40 (default), Thick 70, Heavy 120. At about three-quarters of the budget the model is told to start wrapping up, two steps before the end to stop starting new work, and the last step has tools switched off, so it always finishes with an answer (and says what's left, which you can pick up with "continue").
- **Incognito** (hat button, top right): a chat that isn't saved to your history or this device and doesn't read or change memory. Tap again, or open another chat, and it's gone.
- **Menu** (three lines, top left): your chats, **New chat** and Settings.
- **Settings → Font:** Slab Serif (default), Sans, System, Serif, Rounded or Mono. **Settings → Background:** black (default) or a dark pastel: lavender, sage, rose, slate, peach or teal. The app is always dark.
- On phones the header stays at the top when the keyboard opens: the app shrinks to the space above the keyboard instead of sliding up.

## Two providers: OpenRouter and UberLLM (v5)

Pick one in **Settings → Provider**. Chat, pictures and video all go through it, and each provider keeps its own key, models, picture model and video model, so you can switch back and forth.

| | OpenRouter | UberLLM |
|---|---|---|
| Key | `sk-or-...` from [openrouter.ai](https://openrouter.ai/settings/keys) | `ull_...` from [uberllm.dev](https://uberllm.dev) (Dashboard → Keys) |
| How it's priced | List prices from each model maker | Sellers compete, often below list price; no monthly fee, card top-ups cost 5.5% + $0.50 |
| Web search | Built in (its `web` plugin) | DuckDuckGo results through Jina Reader (free) |
| Pictures | Gemini Flash Image, GPT Image 2, Flux 3 | Nano Banana 2, GPT Image 2.5 Flare, Flux 2 Pro; edits use Nano Banana 2 Edit |
| Video | Veo 3.1 Fast, Veo 3.1, Kling, Wan | Veo 3.1 Fast / full / Lite and Kling 3, through Fal |

Settings shows the chosen model's **live price** on that provider, because UberLLM prices change as sellers compete. When this was built (18 Nov 2026), Kimi K3.1 Pro cost about $0.25 / $8.82 per million tokens in / out on UberLLM and $0.24 / $8.40 on OpenRouter, so check before assuming one is cheaper.

Both providers let the browser call them directly, so you don't need a server for either one.

## Run it on your own server (free)

By default the agent runs inside your phone's browser, so it stops when you close the app. Since v4.2 it can run on your own server instead, so it **keeps working when you close the app**. The server also has **real Python with internet access**, takes screenshots with a real browser, and reads any web page directly.

Your chats stay on your phone. For each message, the app sends the conversation and the files it needs to your server, shows the live progress, and saves the result. Close the app mid-job and the result waits on the server for up to 3 hours; open the app again and it's collected.

### Set it up on Render's free plan (about 15 minutes, no card)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Choose **New → Blueprint**, pick the `mini-agent` repo, and Render reads `render.yaml`.
3. It asks for its secrets:
   - `OPENROUTER_API_KEY` and/or `UBERLLM_API_KEY`: your provider key(s). Fill in the one(s) you use and leave the other empty. They live only on the server.
   - `APP_PASSWORD`: a password you make up. The app signs in with it.

   Already deployed v4? Add `UBERLLM_API_KEY` under your service's **Environment** in Render. The provider you pick in the app's Settings is used on the server too, if the server has that key.
4. Click **Deploy**. The first build takes about 5–10 minutes. When it's live, copy its address, like `https://mini-agent-xxxx.onrender.com`.
5. In the app, open **Settings → Server**, paste the address and the password, and tap **Connect**. You can also open the server's address directly: it serves the same app and asks for the password.

### What the free plan is like

- **It naps.** After 15 minutes with no visits it goes to sleep, and the first message after that takes about a minute while it wakes. The status line says so.
- **It stays awake while it works.** While a job runs, or a finished result is waiting for you, the server keeps itself awake (for up to 3 hours), so the work isn't lost.
- **It's small:** 512 MB of memory and a tenth of a processor. Python and screenshots are slower than on a laptop, and it runs one job at a time.
- **Its disk is wiped when it sleeps.** That's why your chats and files stay on your phone, and the server only keeps a job's files until you've collected the result.
- **Your secrets stay safe.** The agent's Python runs as a separate low-privilege user that can't read your key or password, and pages it opens can't reach the server's internal network.

To run the server somewhere else, the `Dockerfile` works on any host that runs Docker (Railway, Fly.io, Google Cloud Run, a VPS). Set the same secrets.

### opencode as the brain (experimental, off)

The server can hand each job to [opencode](https://opencode.ai), the open-source agent harness, instead of myGPT's own loop (`server/brain.mjs`). opencode does the thinking, todo list, file edits, shell and helper agents; myGPT gives it its web search, page reader, screenshots, pictures, video and memory as tools (over MCP), and calls the model for it so your keys never reach it. It runs as the low-privilege user, and the app shows its progress like any other job.

It's **switched off** for now: opencode needs about 1 GB of memory (measured 230 MB idle and 450–740 MB while working), so it won't fit Render's free 512 MB, and the Docker image doesn't include it yet. To try it on a bigger server: install it (`npm i -g opencode-ai@1.19.6`) and set `BRAIN=opencode` (or `BRAIN=auto` to use it only when there's about 1 GB). Settings → Server then says which brain is running.

## Built for bigger jobs (v3)

- **A plan you can watch.** For jobs of 3 or more steps, it writes a short plan first. It shows as a checklist under the status line, with each step ticked off as it finishes. Afterwards the plan sits at the top of the steps.
- **Several things at once.** Independent lookups run at the same time (for example 3 searches at once). For a big job with separate parts, it hands each part to a **helper agent**. Up to 3 helpers work at once, each with its own tools, and their steps show as "Helper 1: …". The main agent then combines their reports.
- **Attach your own files.** Tap the paperclip, or on a computer drag files onto the window or paste an image. PDFs, Word, Excel, CSV, PowerPoint and images (up to 25 MB each) go into the chat's files. The agent opens documents with Python and looks at images and scanned pages with the screenshot tool.
- **Longer jobs.** It can take up to 60 steps per request (it was 20). When a chat gets long, it shortens old tool output and has the model summarise older messages instead of forgetting them. You'll see "Summarised the earlier conversation to make room" in the steps when that happens.
- **Memory across chats.** Tell it something lasting, like "I run a phone shop in Pune", and it saves a short note. Every chat then starts knowing it. See and delete notes in **Settings → Memory**, or turn memory off. It's told never to save passwords, card or ID numbers, or health details. Notes stay on your device.
- **Real page reading.** fetch_webpage now returns the page's own text instead of another model's summary, and reads long pages part by part.

## Pictures and video (v3.2)

These use picture and video models on the provider you picked, with the same key.

- **Pictures:** ask for a poster, product shot, logo or social post, or attach a photo and ask for changes ("make this a watercolour", "put this phone on a marble table"). The picture appears in the chat as a file you can share or download, and the agent checks it with a screenshot when text or details matter. Pictures cost about $0.01 to $0.13 each.
- **Video:** ask for a clip, or to animate a picture. Before anything is charged, it shows the length, quality, model and **estimated price**, and waits for you to tap **Make Video**. Clips take 1 to 3 minutes and play in the chat. Prices run from about $0.03 to $0.40 per second, so a 6-second clip is usually $0.30 to $2.40.
- Pick the models in **Settings → Picture model** and **Video model**, or type any model ID from [openrouter.ai/models](https://openrouter.ai/models) or [uberllm.dev/models](https://uberllm.dev/models).

If a phone or browser can't download a finished video directly, the answer gives you a time-limited link to it instead.

## It checks its own work

myGPT has a **screenshot** tool. After it makes a chart, PDF, Word, Excel, CSV or HTML file, it takes a screenshot and asks a vision model a specific question, such as "Are the axis labels readable?" or "Does the total read ₹10,62,000?". If something's wrong, it fixes the file and checks again. It can also screenshot a web page to see what it looks like.

- You see each screenshot in the steps under the answer. Tap it to view it full size.
- Files are drawn inside the browser: images as they are, PDFs with [pdf.js](https://mozilla.github.io/pdf.js/), and documents and web pages with [html-to-image](https://github.com/bubkoo/html-to-image) inside a sandboxed frame, so a page the agent made can't reach this app or your keys.
- Web pages are captured by [Microlink](https://microlink.io). Without a key it allows about 25 screenshots a day.
- The vision model is set in **Settings → Vision model**. The default is `anthropic/claude-haiku-5.5`; Kimi K3.1 Pro reads images too.
- PowerPoint files can't be screenshotted. The agent checks those by reading them with python-pptx.

## Debate mode: two models check each other

Turn on **Settings → Debate** and pick a **Reviewer**. Every answer then goes through a debate before you see it:

1. Your main model (the **writer**, Kimi K3.1 Pro by default) does the work: searches, code, files. Then it writes a draft.
2. The **reviewer** (Claude Sonnet 5.5 by default) checks the draft. It can verify facts with web search, redo maths with the calculator, and screenshot or read the files the writer made. Then it says **agree**, or lists what's wrong.
3. The writer weighs each point, fixes what's right (including the files), pushes back on what isn't, and writes a new answer.
4. Steps 2 and 3 repeat until the reviewer agrees, up to 3 rounds. If they still disagree after that, the answer says what they disagree on.

While it runs, a coloured tag in the status line shows whose turn it is (blue for the writer, orange for the reviewer). Afterwards the summary says, for example, **Worked for 40s, agreed after 2 rounds**. Tap it to read the whole exchange. The title shows **Kimi ⇄ Claude, debating** while it's on.

It's slower and costs more. It works best when the reviewer is a different model from the writer. If the reviewer can't be reached (no credits, rate limit), you still get the writer's answer, with a note in the steps.

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
2. **Get a key** from OpenRouter (https://openrouter.ai/settings/keys, starts with `sk-or-`) or UberLLM (https://uberllm.dev, starts with `ull_`) and add a few dollars of credit. Picture and video models need more than $1 of credit.
3. **Open the app** and paste your key; it picks the right provider from the key. It's saved only in that browser, never in this repo. Add the other provider's key later in Settings if you want both.

myGPT was called myGPT until v5. Your chats, files, memory and settings carried over.

## Choosing a model

| Model | ID | Notes |
|---|---|---|
| Kimi K3.1 Pro | `moonshotai/kimi-k3.1-pro` | Default. Strongest at long, multi-step jobs; reads images; 1M-token context. Settings shows its live price on your provider |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` | Careful and clear; the default reviewer in Debate mode |
| GPT-OSS 120B | `openai/gpt-oss-120b` | Cheapest, roughly 10x less than Kimi, but weaker at long jobs |

Any OpenRouter or UberLLM model that supports tool calling works: type its ID in **Settings → Model → Other model ID**. Filter by "Tools" at https://openrouter.ai/models.

If OpenRouter asks it to slow down (rate limits, mostly on free `:free` models), myGPT waits the time it's given (up to about 45 seconds) and tries again by itself.

## Optional: a page reader relay

Browsers can't fetch most websites directly, so myGPT reads pages through the free Jina Reader. For sites that block it, you can deploy your own small reader for free:

1. Sign in at https://vercel.com with GitHub, choose **Add New → Project**, and import `mini-agent`. Leave every setting as it is and deploy.
2. Open your new `https://<something>.vercel.app` link (that copy uses the reader automatically), or paste that address into **Settings → Page reader relay** to use it from GitHub Pages.

The reader (`api/fetch.js`) fetches the page and returns its text. It stores nothing, refuses private network addresses, and only accepts requests from `varun-emm.github.io` or its own site. To allow other sites, set an `ALLOWED_ORIGINS` environment variable in Vercel, as a comma-separated list.

## How it works

The model only ever writes text. `app.js` is the **harness** around it:

1. **Think:** send the chat, a system prompt and the tool menu to the model on OpenRouter.
2. **Act:** if the reply asks for a tool, run that tool in the browser.
3. **Observe:** add the tool's result to the conversation.
4. **Check:** repeat until the model answers without asking for a tool, with a limit of 60 steps.

| Concept | Where it lives |
|---|---|
| Agent loop | `agentLoop()` in `app.js` (`runTurn()` runs one request) |
| Plan | `update_plan` tool, `planNode()` |
| Parallel work | `PARALLEL_SAFE` tools run together in `agentLoop()`; `delegate` tool, `helperView()`, `withHelperSlot()` |
| Long jobs | `compactContext()`, `summarise()`, `repairToolPairs()` |
| Memory | `memory`, `memorySection()`, `remember`/`forget` tools |
| Attachments | `attachFiles()`, `renderPending()` |
| Page reader | `readPage()` (relay, then Jina Reader, then a search model); `api/fetch.js` |
| Server mode | `server/server.mjs` (sign-in, uploads, jobs, live events), `server/engine.mjs` (the agent, generated from `app.js` by `tools/build-engine.py`), `server/sandbox.mjs` (Python, screenshots); in the app: `runRemoteTurn()`, `followJob()`, `collectResult()` |
| Debate | `debate()`, `reviewerPrompt()`, `readVerdict()` |
| Provider | `PROVIDERS` (OpenRouter) and `callLLM()` (OpenAI-style API) |
| Tool definitions | `TOOLS` (each description tells the model *when* to use the tool) |
| Tool code | `TOOL_FUNCTIONS` |
| System prompt | `systemPrompt()` |
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
- **Different brain:** change the model in Settings. Any OpenRouter model ID that supports tools works.

## Command-line version

`cli/agent.py` is the same agent as a Python terminal app, also on OpenRouter (Kimi K3.1 Pro by default; set `AGENT_MODEL` to change it):

```
pip install openai ddgs requests
export OPENROUTER_API_KEY="sk-or-..."
python cli/agent.py
```

## Safety notes

- Your key lives in your browser's local storage. Use **Settings → Forget OpenRouter key** (or UberLLM key) on shared devices.
- Set a credit limit on your provider key. Agent loops use more tokens than plain chat, and Kimi or Claude cost more than the cheapest models.
- Python runs inside a sandbox in your browser. It has no internet access and can only touch the agent's own files, so it runs without asking. Turn on **Ask before running code** if you'd rather approve each run.
- The first time Python runs, the browser downloads it (about 10 MB). After that it's cached.
