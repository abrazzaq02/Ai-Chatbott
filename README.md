# 📚 StudyBuddy — AI Study Chatbot

A complete AI study assistant you can deploy on Netlify for free.

- **Frontend** (`public/`): plain HTML/CSS/JS chat app, no build step. Streams answers live, renders Markdown (tables, code), saves chats in your browser, works on phones, supports dark mode.
- **Backend** (`netlify/functions/chat.mjs`): a Netlify Function at `/api/chat` that calls Claude (Anthropic API). Your API key stays on the server and is never sent to the browser.

### Study modes
| Mode | What it does |
|---|---|
| 💡 Explain | Teaches a topic step by step with examples and a recap |
| ❓ Quiz me | Asks one question at a time, checks your answer, keeps score |
| 📝 Summarize | Turns pasted notes into a summary, key terms, review questions |
| 🗂️ Flashcards | Makes a Front/Back flashcard table |
| 📅 Study plan | Builds a day-by-day plan from your exams and free time |

You can also set a **subject** and **level** (high school, university, …) in the sidebar.

## Deploy on Netlify

1. Get an API key at <https://console.anthropic.com/> (Settings → API Keys).
2. Push this repo to GitHub (already done if you're reading it there).
3. In Netlify: **Add new site → Import an existing project → GitHub →** pick this repo.
   Netlify reads `netlify.toml`, so leave the build settings as they are (publish dir `public`, functions dir `netlify/functions`).
4. Before (or right after) the first deploy go to **Site configuration → Environment variables** and add:
   - `ANTHROPIC_API_KEY` = your key
   - *(optional)* `CLAUDE_MODEL` = a model ID to override the default `claude-opus-5-5`
5. **Deploys → Trigger deploy** (needed so the function picks up the variable). Open your site and start studying.

## Run locally

```bash
npm install
```

```bash
cp .env.example .env   # then put your real key in .env
```

```bash
npm run dev            # starts netlify dev at http://localhost:8888
```

## How it works

```
Browser (public/app.js) --POST /api/chat {messages, mode, subject, level}-->
Netlify Function (chat.mjs) --Anthropic SDK, streaming--> Claude
<-- newline-delimited JSON chunks: {"type":"text"} ... {"type":"done"}
```

- The function keeps the last 40 messages, adds a study-tutor system prompt for the chosen mode, and streams the reply.
- It uses low effort for fast chat replies and turns on Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a declined request is retried on a fallback model.
- Chats are stored in your browser's `localStorage` only; nothing is stored on the server.

## Notes
- Netlify Functions have execution time limits. Replies are streamed and kept short-ish (low effort) to stay well inside them; if a very long answer gets cut off, just ask it to continue.
- You pay Anthropic for API usage. Set a spending limit in the Anthropic Console.
