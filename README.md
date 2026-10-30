# Mini Agent

A tiny AI agent that runs in your browser on [OpenRouter](https://openrouter.ai), which gives one key access to Kimi, Claude, GPT and hundreds of other models. The default brain is **Kimi K3.1 Pro**. It thinks, uses tools, checks its work, loops until the job is done, and hands you real files: Excel, Word, PDF, PowerPoint, charts and more.

**Open it:** https://varun-emm.github.io/mini-agent/ (after the one-time setup below)

The version number is shown next to the title. See [CHANGELOG.md](CHANGELOG.md) for what changed in each one.

## What it can do

| Tool | What it does |
|---|---|
| Web search | OpenRouter's `web` plugin (a small extra fee per search) |
| Read a web page | Gets the page's actual text (long pages in parts), through your relay or the free [Jina Reader](https://jina.ai/reader). Falls back to a search model's report if both fail |
| Calculator | Exact maths, so the model never guesses numbers |
| Python | Runs real Python in your browser with [Pyodide](https://pyodide.org). Libraries like openpyxl, python-docx, python-pptx and fpdf2 install by themselves the first time they're used |
| Files | Makes Excel, Word, PDF, PowerPoint, PNG charts, CSV, Markdown, HTML, JSON, code and ZIP files |
| Screenshot | Takes a screenshot of a file it made (chart, PDF, Word, Excel, CSV, HTML) or of a web page, and has a vision model check it |
| Time | Knows today's date |
| Plan | Shows its plan for a multi-step job as a live checklist |
| Helpers | Hands independent parts of a big job to helper agents that work at the same time |
| Memory | Saves short facts you tell it (name, business, preferences) and uses them in every chat |
| Pictures | Makes and edits images with an AI image model on OpenRouter (posters, product shots, logos, photos) |
| Video | Makes short AI video clips on OpenRouter, after showing you the price and asking first |

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

The app plays your animation frame by frame from a strip of its 125 frames (`assets/loader-frames.webp`), so it controls the speed and direction. It never plays slower than 1× or faster than 5×: text pouring in pushes it up a level, each finished step gives it a burst, and it turns round instantly instead of slowing through a stop. Its colours slide around the colour wheel (a hue shift) while saturation and transparency stay normal. Speed and colour shift both follow how fast text is arriving, each beat pushes the colours a little further, every finished step gives it a little pop and a quick colour jump, and it eases between moods. When the work is done it swells once and shrinks away.

## Built for bigger jobs (v3)

- **A plan you can watch.** For jobs of 3 or more steps, it writes a short plan first. It shows as a checklist under the status line, with each step ticked off as it finishes. Afterwards the plan sits at the top of the steps.
- **Several things at once.** Independent lookups run at the same time (for example 3 searches at once). For a big job with separate parts, it hands each part to a **helper agent**. Up to 3 helpers work at once, each with its own tools, and their steps show as "Helper 1: …". The main agent then combines their reports.
- **Attach your own files.** Tap the paperclip, or on a computer drag files onto the window or paste an image. PDFs, Word, Excel, CSV, PowerPoint and images (up to 25 MB each) go into the chat's files. The agent opens documents with Python and looks at images and scanned pages with the screenshot tool.
- **Longer jobs.** It can take up to 60 steps per request (it was 20). When a chat gets long, it shortens old tool output and has the model summarise older messages instead of forgetting them. You'll see "Summarised the earlier conversation to make room" in the steps when that happens.
- **Memory across chats.** Tell it something lasting, like "I run a phone shop in Pune", and it saves a short note. Every chat then starts knowing it. See and delete notes in **Settings → Memory**, or turn memory off. It's told never to save passwords, card or ID numbers, or health details. Notes stay on your device.
- **Real page reading.** fetch_webpage now returns the page's own text instead of another model's summary, and reads long pages part by part.

## Pictures and video (v3.2)

These use picture and video models on OpenRouter, with the same key.

- **Pictures:** ask for a poster, product shot, logo or social post, or attach a photo and ask for changes ("make this a watercolour", "put this phone on a marble table"). The picture appears in the chat as a file you can share or download, and the agent checks it with a screenshot when text or details matter. Pictures cost about $0.01 to $0.13 each.
- **Video:** ask for a clip, or to animate a picture. Before anything is charged, it shows the length, quality, model and **estimated price**, and waits for you to tap **Make Video**. Clips take 1 to 3 minutes and play in the chat. Prices run from about $0.03 to $0.40 per second, so a 6-second clip is usually $0.30 to $2.40.
- Pick the models in **Settings → Picture model** and **Video model**, or type any model ID from [openrouter.ai/models](https://openrouter.ai/models).

If a phone or browser can't download a finished video directly, the answer gives you a time-limited link to it instead.

## It checks its own work

Mini Agent has a **screenshot** tool. After it makes a chart, PDF, Word, Excel, CSV or HTML file, it takes a screenshot and asks a vision model a specific question, such as "Are the axis labels readable?" or "Does the total read ₹10,62,000?". If something's wrong, it fixes the file and checks again. It can also screenshot a web page to see what it looks like.

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
2. **Get an OpenRouter key** at https://openrouter.ai/settings/keys (keys start with `sk-or-`) and add a few dollars of credit. Picture and video models need more than $1 of credit.
3. **Open the app** and paste your key. It's saved only in that browser, never in this repo.

Mini Agent used to support Groq as well. Since v4.0 it runs on OpenRouter only; if you had a Groq key saved, the app asks for an OpenRouter key instead.

## Choosing a model

| Model | ID | Notes |
|---|---|---|
| Kimi K3.1 Pro | `moonshotai/kimi-k3.1-pro` | Default. Strongest at long, multi-step jobs; reads images; 1M-token context. About $2 per million input tokens and $10 per million output tokens, so a typical multi-step task is roughly $0.20 to $0.50 |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` | Careful and clear; the default reviewer in Debate mode |
| GPT-OSS 120B | `openai/gpt-oss-120b` | Cheapest, roughly 10x less than Kimi, but weaker at long jobs |

Any OpenRouter model that supports tool calling works: type its ID in **Settings → Model → Other model ID**. Filter by "Tools" at https://openrouter.ai/models.

If OpenRouter asks it to slow down (rate limits, mostly on free `:free` models), Mini Agent waits the time it's given (up to about 45 seconds) and tries again by itself.

## Optional: a page reader relay

Browsers can't fetch most websites directly, so Mini Agent reads pages through the free Jina Reader. For sites that block it, you can deploy your own small reader for free:

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

- Your key lives in your browser's local storage. Use **Settings → Forget OpenRouter key** on shared devices.
- Set a credit limit on your OpenRouter key. Agent loops use more tokens than plain chat, and Kimi or Claude cost more than the cheapest models.
- Python runs inside a sandbox in your browser. It has no internet access and can only touch the agent's own files, so it runs without asking. Turn on **Ask before running code** if you'd rather approve each run.
- The first time Python runs, the browser downloads it (about 10 MB). After that it's cached.
