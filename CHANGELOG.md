# Changelog

The version shows next to the title in the app. If it doesn't match the newest number here, close and reopen the tab.

Numbering: **major** for a big redesign, **minor** for a new feature, **patch** for a fix.

| Version | Date | What changed | Commit |
|---|---|---|---|
| 3.2.0 | 2026-10-22 | Makes and edits pictures, and makes short videos (after showing the price and asking), with AI models on OpenRouter. Loader animation now runs between 1× and 5× (1× waiting, 2× thinking, 3× backwards searching, 5× making things), never slower. Fixed a reply vanishing if sent the instant after tapping New chat | (this release) |
| 3.1.0 | 2026-10-21 | The loader's own animation now plays at a speed set by the task: slow while waiting, faster while thinking, fastest while making files, backwards while searching, and eases to a stop at the end | [8eaad55](https://github.com/varun-emm/mini-agent/commit/8eaad55) |
| 3.0.0 | 2026-10-21 | Bigger jobs: a live plan checklist; parallel searches and helper agents; attach your own files; up to 60 steps with old messages summarised instead of forgotten; memory across chats (Settings → Memory); real web page text with a reader. Stopping mid-task no longer breaks the next message | [859e6be](https://github.com/varun-emm/mini-agent/commit/859e6be) |
| 2.6.0 | 2026-10-20 | Debate mode: Groq and OpenRouter debate each answer until they agree (up to 3 rounds). Switch in Settings → Debate | [13a5ea7](https://github.com/varun-emm/mini-agent/commit/13a5ea7) |
| 2.5.0 | 2026-10-20 | Version number shown next to the title, and this changelog | [871bbe9](https://github.com/varun-emm/mini-agent/commit/871bbe9) |
| 2.4.0 | 2026-10-20 | Loader colours shift around the colour wheel with the task (backwards while searching). Saturation and see-through back to normal | [d3f4875](https://github.com/varun-emm/mini-agent/commit/d3f4875) |
| 2.3.0 | 2026-10-19 | Loader saturation and see-through change with the task (never below 60%) | [ecaa6cd](https://github.com/varun-emm/mini-agent/commit/ecaa6cd) |
| 2.2.2 | 2026-10-19 | Settings no longer cut off on iPhone. Waits and retries by itself when Groq's rate limit is hit. Ready for the next message as soon as an answer finishes | [84afa2f](https://github.com/varun-emm/mini-agent/commit/84afa2f) |
| 2.2.1 | 2026-10-19 | Settings button easier to find on phones (top of the sidebar, and tapping the model name) | [15f7782](https://github.com/varun-emm/mini-agent/commit/15f7782) |
| 2.2.0 | 2026-10-19 | Checks its own work with screenshots and a vision model. Chat history in a sidebar. Loader pulses with the task | [2e80841](https://github.com/varun-emm/mini-agent/commit/2e80841) |
| 2.1.0 | 2026-10-19 | Replies stream in live, the status line shows the model's real thoughts, smooth transitions, loader spins faster or backwards with the task | [1ce0b30](https://github.com/varun-emm/mini-agent/commit/1ce0b30) |
| 2.0.0 | 2026-10-19 | Apple-style redesign. Makes real files (Excel, Word, PDF, PowerPoint, charts) with Python in the browser. Your animation as the loader | [9e26884](https://github.com/varun-emm/mini-agent/commit/9e26884) |
| 1.1.0 | 2026-10-19 | OpenRouter keys work alongside Groq | [25472d3](https://github.com/varun-emm/mini-agent/commit/25472d3) |
| 1.0.0 | 2026-10-14 | First release: an agent on Groq with web search, calculator and Python | [27bcf2e](https://github.com/varun-emm/mini-agent/commit/27bcf2e) |
