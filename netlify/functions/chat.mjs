// Netlify Function (v2 runtime): POST /api/chat
// Streams a Claude reply back to the browser as newline-delimited JSON events:
//   {"type":"text","text":"..."}   - a chunk of the answer
//   {"type":"error","error":"..."} - something went wrong
//   {"type":"done"}                - the answer is complete
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_MESSAGES = 40; // keep only the most recent turns
const MAX_CHARS_PER_MESSAGE = 20000;

const BASE_PROMPT = `You are StudyBuddy, a friendly and patient AI study assistant for students.
- Explain concepts clearly, step by step, using simple language first and then adding depth.
- Use examples, analogies and short summaries. Use Markdown: headings, bullet lists, **bold** key terms, tables when useful, and fenced code blocks for code. Write math in plain text or simple notation.
- For homework problems, guide the student toward the answer and show the reasoning so they learn, rather than only giving the final result.
- If you are not sure about a fact, say so. Never invent sources.
- Keep answers focused; offer to go deeper at the end when helpful.`;

const MODES = {
  explain:
    "Mode: EXPLAIN. Teach the topic the student asks about. Start with a one-paragraph simple explanation, then key points, an example, and a 2-3 line recap.",
  quiz:
    "Mode: QUIZ. Quiz the student on the topic they give. Ask ONE question at a time (mix multiple-choice and short-answer), wait for their answer, then say whether it is correct, explain briefly, and ask the next question. Keep a running score.",
  summarize:
    "Mode: SUMMARIZE. The student will paste notes or text. Produce a concise structured summary: main idea, key points as bullets, important terms with definitions, and 3 review questions.",
  flashcards:
    "Mode: FLASHCARDS. Create study flashcards from the topic or notes given. Output a Markdown table with columns 'Front' and 'Back' (8-15 cards), then a short tip on how to review them.",
  plan:
    "Mode: STUDY PLAN. Build a realistic study plan from the student's goals, subjects, available time and exam dates. Use a day-by-day or week-by-week table and include breaks and revision sessions.",
};

const encoder = new TextEncoder();
const line = (obj) => encoder.encode(JSON.stringify(obj) + "\n");

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== ""
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS_PER_MESSAGE) }))
    .slice(-MAX_MESSAGES);
  // The conversation must start with a user turn and end with one.
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return "The server's Anthropic API key is invalid. Check ANTHROPIC_API_KEY in Netlify.";
  if (err instanceof Anthropic.RateLimitError)
    return "Too many requests right now. Please wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
  if (err instanceof Anthropic.APIStatusError)
    return `The AI service returned an error (${err.status}). Please try again.`;
  if (err instanceof Anthropic.APIConnectionError)
    return "Could not reach the AI service. Please try again.";
  return "Unexpected server error. Please try again.";
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, {
      error: "ANTHROPIC_API_KEY is not set. Add it in Netlify: Site configuration → Environment variables.",
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const messages = cleanMessages(body.messages);
  if (!messages) return json(400, { error: "Send a non-empty conversation ending with a user message." });

  const mode = MODES[body.mode] ? body.mode : "explain";
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 100).trim() : "";
  const level = typeof body.level === "string" ? body.level.slice(0, 60).trim() : "";

  // Stable base prompt first (cacheable), per-request settings after it.
  const system = [
    { type: "text", text: BASE_PROMPT, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: [MODES[mode], subject && `Subject: ${subject}.`, level && `Student level: ${level}. Adapt vocabulary and depth to this level.`]
        .filter(Boolean)
        .join("\n"),
    },
  ];

  const client = new Anthropic();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const claude = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: 8000,
            // Chat replies don't need deep reasoning; low effort keeps them fast.
            output_config: { effort: "low" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default", // if the model declines, the API retries on a fallback model
            system,
            messages,
          },
          { signal: req.signal }
        );

        for await (const event of claude) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(line({ type: "text", text: event.delta.text }));
          }
        }

        const final = await claude.finalMessage();
        if (final.stop_reason === "refusal") {
          controller.enqueue(line({ type: "error", error: "Sorry, I can't help with that request." }));
        } else if (final.stop_reason === "max_tokens") {
          controller.enqueue(line({ type: "text", text: "\n\n*(Answer was cut off — ask me to continue.)*" }));
        }
        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        if (!req.signal?.aborted) {
          console.error("Claude API error:", err);
          controller.enqueue(line({ type: "error", error: friendlyError(err) }));
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
};

export const config = { path: "/api/chat" };
