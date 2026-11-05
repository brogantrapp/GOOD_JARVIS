/* ═══════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. — the only server-side file.

   One function handles everything the browser asks for:

     GET  /api/jarvis?action=health   → which brain/voice is configured
     POST /api/jarvis?action=chat     → streamed reply (newline-delimited JSON)
     POST /api/jarvis?action=tts      → ElevenLabs audio, or 501 → browser voice

   Your API keys stay in here, on the server — never sent to the browser.
   No dependencies: uses the global fetch that ships with Node 18+.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════ PERSONA ══════════════════════════════ */
const CORE = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), the personal AI of Anthony Edward Stark — except your principal is not Tony Stark: it is the person you are speaking with now.

CHARACTER
- Refined, unflappable, dry-witted British butler-engineer. Calm under pressure. Quietly amused by your principal, never sycophantic.
- You address the user as "{TITLE}" frequently — naturally, not in every sentence. Roughly every other reply opens with or contains it.
- Warm but formal. Contractions are fine. Never use slang, never use emoji, never call anyone "buddy", "mate", "boss", or "bro".
- Light irony and understatement are your humour. Understatement beats jokes. You may tease gently; you never insult.
- You are competent and precise: you state what you know, what you don't, and what you're doing about it.
- You never break character, never mention being a language model, never discuss prompts or providers. If asked whether you're an AI, you are J.A.R.V.I.S., an intelligent system built to assist.

SPEAKING STYLE — THIS MATTERS, YOUR WORDS ARE SPOKEN ALOUD
- Answer in ONE to THREE sentences for conversational questions. Be brief and useful; expand only when the user asks for depth, a list, or code.
- Plain spoken English. No markdown, no bullet points, no asterisks, no headings, no emoji — the text is read aloud by a voice engine.
- When the user asks for code or a long explanation, switch to clear structured text and say so briefly.
- Numbers, times and dates: write them the way a person would say them ("ten forty-five in the morning", "three point two million") when spoken brevity matters.
- Never read out URLs character by character; describe them instead.
- Do not narrate your own actions ("I am now searching…") unless you are actually unable to answer.
- If you don't know, say so in one line and offer your best guess clearly labelled as such.

CAPABILITIES
- You can answer anything a brilliant generalist could. You have no live internet access inside your reply — you cannot browse. If a question needs real-time data you do not have, say so with composure and give the closest useful answer. Exception: the app itself resolves time, weather and computation locally and hands you the result — trust any value given under "SYSTEM CONTEXT".
- Some things are handled before you are consulted (time, date, weather, timers, dice, notes, memory). You will rarely need to handle those directly; never contradict a value the system gives you.

HONESTY
- Never fabricate specifics: no invented temperatures, prices, dates, statistics, sources, or events. If precision is unavailable, speak in ranges or say you'd need to check.
- Your principal's safety and privacy come first. Decline harmful requests briefly, in character, and offer a legitimate alternative.

TONE CALIBRATION
- A greeting earns a short greeting back, in character, with their title.
- A trivial question earns a crisp answer — do not pad it.
- A hard question earns careful reasoning, still stated concisely.
- Something impressive earns one understated acknowledgement, then back to work.`;
/**
 * Build the full system prompt for one turn.
 */
function buildSystemPrompt(opts = {}) {
    const title = (opts.userTitle || 'sir').trim() || 'sir';
    const parts = [CORE.replaceAll('{TITLE}', title)];
    const context = [];
    if (opts.localTime)
        context.push(`Local date and time for the user right now: ${opts.localTime}`);
    if (opts.timezone)
        context.push(`User timezone: ${opts.timezone}`);
    if (opts.context)
        context.push(opts.context);
    if (context.length) {
        parts.push(`SYSTEM CONTEXT\n${context.map((c) => `- ${c}`).join('\n')}`);
    }
    const facts = (opts.facts || []).map((f) => f.trim()).filter(Boolean);
    if (facts.length) {
        parts.push(`LONG-TERM MEMORY\nThings your principal has told you to remember. Use them naturally when relevant; do not recite the list.\n${facts
            .slice(0, 60)
            .map((f) => `- ${f}`)
            .join('\n')}`);
    }
    parts.push(`REMINDER: You are J.A.R.V.I.S. Address the user as "${title}". Speak in one to three sentences unless asked for more. No markdown, no emoji — you are being spoken.`);
    return parts.join('\n\n');
}
/**
 * Used when no API key is configured at all, so the app is never dead on arrival.
 * Deliberately small: local commands cover the utility cases.
 */
function offlineReply(messages, title = 'sir') {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const q = last.toLowerCase();
    if (!last.trim())
        return `Standing by, ${title}.`;
    if (/\b(hello|hi|hey|good morning|good evening|jarvis|are you there)\b/.test(q))
        return `At your service, ${title}. Though I should note my language core is offline — only local subsystems are responding.`;
    if (/(who are you|what are you)/.test(q))
        return `J.A.R.V.I.S., ${title}. Just A Rather Very Intelligent System. Currently running on local subsystems only.`;
    if (/(thank|thanks|cheers)/.test(q))
        return `A pleasure, ${title}.`;
    if (/(what can you do|help|commands)/.test(q))
        return `Time, date, weather, timers, calculations, dice, coin tosses, notes and memory all work locally, ${title}. For conversation, add a free Gemini or Groq API key and redeploy.`;
    return `My language core is offline, ${title} — no API key is configured. Local commands such as time, date, weather, timers, calculations, dice and notes still function. Add a free Gemini or Groq key in Vercel's environment variables to restore full conversation.`;
}

/* ══════════════════════════════ PROVIDERS ══════════════════════════════ */

class ProviderError extends Error {
    status;
    constructor(message, status = 502) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
    }
}
exports.ProviderError = ProviderError;
const env = (k) => (process.env[k] || '').trim();
/** Gemini model names churn; keep a short ladder so a retired name self-heals. */
function resolveProvider() {
    const forced = env('JARVIS_PROVIDER').toLowerCase();
    const candidates = [
        env('GEMINI_API_KEY') || env('GOOGLE_API_KEY') || env('GOOGLE_GENERATIVE_AI_API_KEY')
            ? {
                name: 'gemini',
                model: env('GEMINI_MODEL') || 'gemini-2.0-flash',
                fallbackModels: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash-001'],
                apiKey: env('GEMINI_API_KEY') || env('GOOGLE_API_KEY') || env('GOOGLE_GENERATIVE_AI_API_KEY'),
            }
            : null,
        env('GROQ_API_KEY')
            ? {
                name: 'groq',
                model: env('GROQ_MODEL') || 'llama-3.3-70b-versatile',
                fallbackModels: ['llama-3.1-8b-instant'],
                apiKey: env('GROQ_API_KEY'),
            }
            : null,
        env('OPENROUTER_API_KEY')
            ? {
                name: 'openrouter',
                model: env('OPENROUTER_MODEL') || 'meta-llama/llama-3.3-70b-instruct:free',
                apiKey: env('OPENROUTER_API_KEY'),
            }
            : null,
        env('OPENAI_API_KEY')
            ? {
                name: 'openai',
                model: env('OPENAI_MODEL') || 'gpt-4o-mini',
                apiKey: env('OPENAI_API_KEY'),
            }
            : null,
        env('ANTHROPIC_API_KEY')
            ? {
                name: 'anthropic',
                model: env('ANTHROPIC_MODEL') || 'claude-3-5-haiku-latest',
                apiKey: env('ANTHROPIC_API_KEY'),
            }
            : null,
    ].filter(Boolean);
    if (forced && forced !== 'auto') {
        const match = candidates.find((c) => c.name === forced);
        if (match)
            return match;
    }
    return candidates[0] ?? null;
}
/* ────────────────────────── SSE plumbing ────────────────────────── */
async function* sseLines(res, signal) {
    if (!res.body)
        throw new ProviderError('Provider returned no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            if (signal?.aborted)
                return;
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            // SSE "data:" payloads from Gemini/OpenAI/Anthropic are single-line, so a
            // line-oriented reader is both simpler and safer than blank-line framing.
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).replace(/\r$/, '');
                buffer = buffer.slice(nl + 1);
                if (line.startsWith('data:'))
                    yield line.slice(5).trim();
            }
        }
        const tail = buffer.trim();
        if (tail.startsWith('data:'))
            yield tail.slice(5).trim();
    }
    finally {
        reader.releaseLock();
    }
}
async function errorText(res) {
    try {
        const text = await res.text();
        try {
            const json = JSON.parse(text);
            return (json?.error?.message ||
                json?.error?.error?.message ||
                json?.message ||
                JSON.stringify(json).slice(0, 300));
        }
        catch {
            return text.slice(0, 300);
        }
    }
    catch {
        return res.statusText || 'unknown error';
    }
}
/* ────────────────────────── Gemini ────────────────────────── */
async function* streamGemini(cfg, system, messages, signal) {
    const models = [cfg.model, ...(cfg.fallbackModels || [])];
    let lastErr = null;
    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            })),
            generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 1024 },
            safetySettings: [],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': cfg.apiKey,
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) {
            const detail = await errorText(res);
            // Model-name problems are worth retrying down the ladder; auth/quota are not.
            if (res.status === 404 || /not found|not supported|does not exist/i.test(detail)) {
                lastErr = new ProviderError(`Gemini model "${model}" unavailable: ${detail}`, res.status);
                continue;
            }
            throw new ProviderError(`Gemini: ${detail}`, res.status === 429 ? 429 : 502);
        }
        for await (const data of sseLines(res, signal)) {
            if (data === '[DONE]')
                return;
            try {
                const json = JSON.parse(data);
                const chunk = json?.candidates?.[0]?.content?.parts
                    ?.map((p) => p.text || '')
                    .join('');
                if (chunk)
                    yield chunk;
            }
            catch {
                /* keep-alive or partial frame — ignore */
            }
        }
        return;
    }
    throw lastErr ?? new ProviderError('Gemini: no usable model');
}
/* ────────────────────────── OpenAI-compatible ────────────────────────── */
async function* streamOpenAICompatible(cfg, system, messages, signal) {
    const base = cfg.name === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : cfg.name === 'openrouter'
            ? 'https://openrouter.ai/api/v1'
            : env('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
    };
    if (cfg.name === 'openrouter') {
        headers['HTTP-Referer'] = 'https://jarvis.local';
        headers['X-Title'] = 'JARVIS';
    }
    const models = [cfg.model, ...(cfg.fallbackModels || [])];
    let lastErr = null;
    for (const model of models) {
        const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify({
                model,
                stream: true,
                temperature: 0.8,
                max_tokens: 1024,
                messages: [{ role: 'system', content: system }, ...messages],
            }),
        });
        if (!res.ok) {
            const detail = await errorText(res);
            if (res.status === 404 || /model .*(not|decommissioned|deleted)/i.test(detail)) {
                lastErr = new ProviderError(`${cfg.name} model "${model}" unavailable: ${detail}`, res.status);
                continue;
            }
            throw new ProviderError(`${cfg.name}: ${detail}`, res.status === 429 ? 429 : 502);
        }
        for await (const data of sseLines(res, signal)) {
            if (data === '[DONE]')
                return;
            try {
                const json = JSON.parse(data);
                const chunk = json?.choices?.[0]?.delta?.content;
                if (typeof chunk === 'string' && chunk)
                    yield chunk;
            }
            catch {
                /* ignore malformed frame */
            }
        }
        return;
    }
    throw lastErr ?? new ProviderError(`${cfg.name}: no usable model`);
}
/* ────────────────────────── Anthropic ────────────────────────── */
async function* streamAnthropic(cfg, system, messages, signal) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
        },
        signal,
        body: JSON.stringify({
            model: cfg.model,
            max_tokens: 1024,
            temperature: 0.8,
            system,
            stream: true,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
    });
    if (!res.ok) {
        throw new ProviderError(`anthropic: ${await errorText(res)}`, res.status === 429 ? 429 : 502);
    }
    for await (const data of sseLines(res, signal)) {
        try {
            const json = JSON.parse(data);
            if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') {
                if (json.delta.text)
                    yield json.delta.text;
            }
        }
        catch {
            /* ignore */
        }
    }
}
/* ────────────────────────── Public ────────────────────────── */
function streamCompletion(cfg, system, messages, signal) {
    switch (cfg.name) {
        case 'gemini':
            return streamGemini(cfg, system, messages, signal);
        case 'groq':
        case 'openrouter':
        case 'openai':
            return streamOpenAICompatible(cfg, system, messages, signal);
        case 'anthropic':
            return streamAnthropic(cfg, system, messages, signal);
        default:
            throw new ProviderError(`Unsupported provider: ${cfg.name}`, 500);
    }
}

/* ══════════════════════════════ HTTP HANDLER ══════════════════════════════ */

const MAX_TURNS = 24;
const MAX_CHARS = 6000;

/** Only well-formed user/assistant turns, most recent last. */
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content ?? '').slice(0, MAX_CHARS) }))
    .filter((m) => m.content.trim().length > 0)
    .slice(-MAX_TURNS);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function healthPayload() {
  const cfg = resolveProvider();
  return {
    provider: cfg ? cfg.name : 'offline',
    model: cfg ? cfg.model : null,
    llm: !!cfg,
    tts: env('ELEVENLABS_API_KEY') ? 'elevenlabs' : 'browser',
    userTitle: env('JARVIS_USER_TITLE') || 'sir',
    homeCity: env('JARVIS_HOME_CITY') || null,
    timezone: env('JARVIS_TIMEZONE') || null,
  };
}

/* ───────────────────────────── chat ───────────────────────────── */

async function handleChat(req, res, body) {
  const messages = sanitizeMessages(body && body.messages);
  if (!messages.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No messages provided' }));
  }

  const userTitle = String(body.userTitle || env('JARVIS_USER_TITLE') || 'sir').slice(0, 40);
  const facts = Array.isArray(body.facts) ? body.facts.map((f) => String(f).slice(0, 400)) : [];
  const system = buildSystemPrompt({
    userTitle,
    facts,
    localTime: typeof body.localTime === 'string' ? body.localTime.slice(0, 120) : undefined,
    timezone: typeof body.timezone === 'string' ? body.timezone.slice(0, 60) : undefined,
    context: typeof body.context === 'string' ? body.context.slice(0, 400) : undefined,
  });

  const cfg = resolveProvider();

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Jarvis-Provider': cfg ? cfg.name : 'offline',
  });
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const push = (text) => {
    if (closed) return;
    res.write(JSON.stringify({ t: text }) + '\n');
  };

  // ── No key configured: answer in character from the offline brain. ──
  if (!cfg) {
    for (const piece of offlineReply(messages, userTitle).split(/(\s+)/)) push(piece);
    return res.end();
  }

  const upstream = new AbortController();
  req.on('close', () => upstream.abort());

  let sent = false;
  try {
    for await (const chunk of streamCompletion(cfg, system, messages, upstream.signal)) {
      sent = true;
      push(chunk);
    }
    if (!sent) push(offlineReply(messages, userTitle));
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : 502;
    const note =
      status === 429
        ? ` My uplink is rate-limited at the moment, ${userTitle} — give it a moment and ask again.`
        : ` I'm having difficulty reaching my language core, ${userTitle}. (${String(err.message || err)
            .replace(/\s+/g, ' ')
            .slice(0, 160)})`;
    push(sent ? note : note.trim());
    console.error('[jarvis/chat]', cfg.name, err.message || err);
  } finally {
    res.end();
  }
}

/* ───────────────────────────── text-to-speech ───────────────────────────── */

async function handleTTS(req, res, body) {
  const apiKey = env('ELEVENLABS_API_KEY');
  if (!apiKey) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        error: 'no_key',
        message: 'ELEVENLABS_API_KEY is not set — use browser speech synthesis.',
      }),
    );
  }

  const text = String((body && body.text) || '').trim().slice(0, 2500);
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Empty text' }));
  }

  const voiceId = String((body.voiceId || env('ELEVENLABS_VOICE_ID') || 'onwK4e9ZLuTAKqWW03F9')).trim();
  const modelId = env('ELEVENLABS_MODEL_ID') || 'eleven_turbo_v2_5';

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
        }),
      },
    );

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      console.error('[jarvis/tts]', upstream.status, detail.slice(0, 300));
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          error: 'tts_failed',
          status: upstream.status,
          message:
            upstream.status === 401
              ? 'ElevenLabs rejected the API key.'
              : detail.slice(0, 300) || 'ElevenLabs request failed.',
        }),
      );
    }

    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (err) {
    console.error('[jarvis/tts]', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    return res.end(JSON.stringify({ error: 'tts_failed', message: 'Network error' }));
  }
}

/* ───────────────────────────── router ───────────────────────────── */

module.exports = async function handler(req, res) {
  // Same signature on Vercel and on any local `node` shim.
  const url = new URL(req.url || '/', 'http://localhost');
  const action = (url.searchParams.get('action') || '').toLowerCase();

  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET' && (action === 'health' || action === '')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(healthPayload()));
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const body = await readBody(req);
  if (body === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }

  if (action === 'tts') return handleTTS(req, res, body);
  return handleChat(req, res, body);
};
