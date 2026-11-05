# J.A.R.V.I.S.

*Just A Rather Very Intelligent System* — a personal, voice-first assistant with an Iron Man HUD.
Say **“Jarvis”**, speak your mind, and he answers in a British butler's voice, calling you **sir**.
You can type to him just as easily.

Everything sits in one flat folder. **No framework, no build step, no npm install, no dependencies.**
Two plain files of JavaScript, one stylesheet, one HTML page, and one serverless function.

![J.A.R.V.I.S. running in a browser](screenshot-desktop.png)

<details>
<summary>More screenshots</summary>

| | |
| --- | --- |
| ![Boot sequence](screenshot-boot.png) | ![Systems panel](screenshot-settings.png) |

<img src="screenshot-mobile.png" alt="J.A.R.V.I.S. on a phone" width="320" />

</details>

---

## Every file, and what it does

```
index.html            the page: HUD markup, settings panel, boot screen
styles.css            all the styling (the Iron Man look)
app.js                the application: wake word, voice, chat, memory, rendering
commands.mjs          instant local commands (time, weather, timers, maths, notes)
speech-utils.mjs      text-to-speech clean-up and British-male voice ranking
api/jarvis.js         the only server-side code: talks to the AI provider, hides your key
dev-server.js         optional: `node dev-server.js` to run the whole thing locally
tests.mjs             optional: `node tests.mjs` to run the unit tests
vercel.json           response headers (microphone permissions etc.)
icon.svg              app icon
manifest.webmanifest  makes it installable on a phone home screen
.env.example          every environment variable, all optional
.gitignore            keeps your keys out of the repo
screenshot-*.png      the images in this README
```

Nothing is generated and nothing is compiled — what you push is what runs.

> **Why is there one folder?** Vercel requires serverless functions to live in `api/`. That's the
> only reason `api/jarvis.js` isn't at the top level. Everything else is flat.

---

## Deploy to your own Vercel

**1. Push it**

```bash
git init
git add .
git commit -m "J.A.R.V.I.S."
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/jarvis.git
git push -u origin main
```

**2. Import it** — go to [vercel.com/new](https://vercel.com/new), pick the repo, press **Deploy**.
There is nothing to configure: Vercel serves the files as a static site and turns `api/jarvis.js`
into a serverless function automatically. (If it asks, the framework preset is **Other**.)

**3. Add one free key** — **Project → Settings → Environment Variables**:

```
GEMINI_API_KEY = <your key>
```

Free, no credit card, from <https://aistudio.google.com/apikey>. Then
**Deployments → ⋯ → Redeploy** so the new variable takes effect.

Open the deployment, press **Initialise**, allow the microphone, and say
*“Jarvis, what's the weather?”*

> With no key at all it still runs: local commands respond and conversation falls back to a small
> in-character offline brain. The header will read `offline core` until you add one.

---

## Picking a brain (every free option)

Set **one**. The app auto-detects whichever is present:

| Variable | Provider | Free tier | Notes |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Google Gemini | ✅ generous, no card | **Recommended.** |
| `GROQ_API_KEY` | Groq | ✅ generous, no card | Fastest replies; Llama 3.3 70B. |
| `OPENROUTER_API_KEY` | OpenRouter | ✅ `:free` models | Many models, one key. |
| `OPENAI_API_KEY` | OpenAI | ❌ paid | Supported if you have one. |
| `ANTHROPIC_API_KEY` | Anthropic | ❌ paid | Supported if you have one. |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | any OpenAI-compatible server | ✅ if local | Ollama, LM Studio, LiteLLM. e.g. `http://localhost:11434/v1` |

Priority is Gemini → Groq → OpenRouter → OpenAI → Anthropic. Override with
`JARVIS_PROVIDER=groq`. Model names can be overridden per provider
(`GEMINI_MODEL`, `GROQ_MODEL`, `OPENROUTER_MODEL`, `OPENAI_MODEL`, `ANTHROPIC_MODEL`), and a
retired Gemini model name self-heals by trying the next one.

Your key is read **only** inside `api/jarvis.js`, on the server. It is never sent to the browser.

---

## The voice

Two engines, in order of preference:

1. **ElevenLabs** — the cinematic, film-accurate voice. Add:
   ```
   ELEVENLABS_API_KEY = <your key>
   ELEVENLABS_VOICE_ID = onwK4e9ZLuTAKqWW03F9   # "Daniel", British male
   ```
   Free tier exists but is limited. If it's missing, rate-limited or rejected, the app quietly
   falls back to the browser voice.

2. **Browser speech synthesis** — free, zero setup. JARVIS auto-selects the best British male voice
   on your device (*Daniel* / *Arthur* / *Oliver* on Apple, *Ryan* / *George* on Windows,
   *Google UK English Male* on Chrome). Choose a specific one in **Systems → Voice**, with rate,
   pitch, volume and a **Test voice** button.

> Voice availability is a property of your device, not of this code. On iOS,
> **Settings → Accessibility → Spoken Content → Voices → Daniel (Enhanced)** makes an audible
> difference.

---

## Using it

**Voice** — press **Initialise**, allow the mic, then:

- *“Jarvis.”* → he replies “Listening, sir…” and waits for your request.
- *“Jarvis, what's the weather in London?”* → one breath, immediate answer.
- *“Jarvis, set a timer for ten minutes.”* → he announces it when it elapses.

**Listening modes** (Systems → Listening):

- **Wake word** — always listening, responds only to “Jarvis”. Best default.
- **Always on** — responds to everything it hears. Use headphones.
- **Push to talk** — mic open only while you press the mic button or **Space**.

**Shortcuts** — `Space` talk · `Enter` send · `Esc` hush / close panel.

**Instant commands** (no API call, no network except weather):

```
what time is it · what's the date
weather · weather in Tokyo · is it raining
set a timer for ten minutes · timer for 90 seconds · remind me in half an hour
what is 12 * 7 · sqrt(144) · 15% of 80 · 2^10
flip a coin · roll a d20 · random number between 1 and 100
remember that I take my coffee black
what do you remember · forget everything
take a note buy arc reactor parts · read my notes · clear my notes
open youtube · what can you do · go to sleep / wake up
stop · clear the conversation
```

Timers accept spoken numbers — “ten minutes”, “twenty five minutes”, “half an hour”.

Everything else goes to the language model, with your remembered facts and the current time
injected into the system prompt so he never guesses what time it is.

---

## Running it locally

No install step, no dependencies:

```bash
node dev-server.js        # → http://localhost:3000
```

`dev-server.js` serves the files and mounts `api/jarvis.js` on `/api/jarvis`, exactly like Vercel
does. It also reads `.env.local` if present, so your keys work locally:

```bash
cp .env.example .env.local
# then paste your GEMINI_API_KEY into it
```

Tests:

```bash
node tests.mjs            # 46 checks: maths parser, commands, speech helpers
```

Speech recognition needs `localhost` or HTTPS — both qualify.

---

## How it works

- **Wake word** — continuous Web Speech recognition; everything is ignored until the transcript
  contains “Jarvis”, which then opens a 12-second window for your request. Push-to-talk bypasses
  the gate entirely.
- **Mic ducking** — recognition is aborted the moment JARVIS starts talking and resumed 250 ms
  after he stops, so he never transcribes himself.
- **Streaming** — the function streams newline-delimited JSON; `app.js` appends each chunk, so
  replies appear word by word and speech starts as soon as a sentence is complete.
- **No `eval`** — arithmetic goes through a hand-written recursive-descent parser.
- **No injection** — every message is rendered with `textContent`, never `innerHTML`.
- **Memory is local** — conversation and facts live in `localStorage` on your device. Nothing is
  stored on the server; *Reset everything* in Systems wipes it.

---

## Troubleshooting

**“Microphone access is blocked”** — padlock in the address bar → Site settings → Microphone →
Allow, then reload. Mic only works on HTTPS or localhost.

**Nothing happens when I say “Jarvis”** — Chrome, Edge or Safari only; Firefox has no speech
recognition. Check the footer state reads `ready` or `listening`.

**He answers his own voice** — use **Wake word** or **Push to talk** instead of **Always on**.

**No British voice** — install one at OS level, or add an ElevenLabs key.

**“offline core” in the header** — no API key seen by the deployment. Environment variables only
apply to *new* deployments: redeploy after adding one.

**Works locally but not on Vercel** — make sure `api/jarvis.js` was committed (it's the only file
in a folder) and that you're on the Node 18+ runtime.

---

*At your service, sir.*
