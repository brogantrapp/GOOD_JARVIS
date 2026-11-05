/* ═══════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. — browser application
   Wake-word voice input, spoken replies, streaming conversation, local
   commands, persistent memory, and the HUD.

   No framework, no build step. The only server call is /api/jarvis.
   ═══════════════════════════════════════════════════════════════════════════ */

import { runCommand } from './commands.mjs';
import {
  sanitizeForSpeech,
  chunkForSpeech,
  pickVoice,
  rankVoices,
  describeVoice,
} from './speech-utils.mjs';

/* ═══════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. — browser application
   Wake-word voice input, spoken replies, streaming conversation, local
   commands, persistent memory, and the HUD.

   No framework, no build step. The only server call is /api/jarvis.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────────── helpers & constants ───────────────────────────── */

const API = '/api/jarvis';
const STORE_KEY = 'jarvis.v1';
const ARM_WINDOW_MS = 12_000;
const FILLERS = /^(uh|um|erm|mm|hmm|ah|oh|you|the|a)[\s.!?]*$/i;

const DEFAULT_SETTINGS = {
  wakeMode: 'wake',
  speakReplies: true,
  userTitle: 'sir',
  voice: { browserVoice: '', rate: 1, pitch: 0.92, volume: 1, preferElevenLabs: true },
};

const $ = (sel, root = document) => root.querySelector(sel);

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const now = () => Date.now();

const timeOf = (at) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const getRecognitionCtor = () =>
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ───────────────────────────── state ───────────────────────────── */

const state = {
  messages: [],
  facts: [],
  notes: [],
  settings: structuredClone(DEFAULT_SETTINGS),
  health: null,
  activated: false,
  busy: false,
  streamingId: null,
  interim: '',
  recState: 'off',
  speaking: false,
  engine: 'browser',
  hydrated: false,
};

let localCoords = null;
let currentStream = null;

/* ───────────────────────────── DOM ───────────────────────────── */

const ui = {
  reactor: $('#reactor'),
  reactorSvg: $('#reactorSvg'),
  statusDot: $('#statusDot'),
  statusLabel: $('#statusLabel'),
  visualizer: $('#visualizer'),
  transcript: $('#transcript'),
  composer: $('#composer'),
  input: $('#input'),
  sendBtn: $('#sendBtn'),
  micBtn: $('#micBtn'),
  micIcon: $('#micIcon'),
  micPulse: $('#micPulse'),
  stopBtn: $('#stopBtn'),
  stateLabel: $('#stateLabel'),
  clock: $('#clock'),
  providerPill: $('#providerPill'),
  providerLabel: $('#providerLabel'),
  notice: $('#notice'),
  noticeText: $('#noticeText'),
  dismissNotice: $('#dismissNotice'),
  boot: $('#boot'),
  initialise: $('#initialise'),
  skipBoot: $('#skipBoot'),
  scrim: $('#scrim'),
  panel: $('#panel'),
  openSettings: $('#openSettings'),
  closeSettings: $('#closeSettings'),
  diagCore: $('#diagCore'),
  diagEngine: $('#diagEngine'),
  diagRecognition: $('#diagRecognition'),
  diagSystemVoice: $('#diagSystemVoice'),
  noteNoKey: $('#noteNoKey'),
  noteNoTts: $('#noteNoTts'),
  wakeModeSeg: $('#wakeModeSeg'),
  wakeModeNote: $('#wakeModeNote'),
  speakReplies: $('#speakReplies'),
  userTitle: $('#userTitle'),
  preferEleven: $('#preferEleven'),
  voiceSelect: $('#voiceSelect'),
  rate: $('#rate'),
  rateValue: $('#rateValue'),
  pitch: $('#pitch'),
  pitchValue: $('#pitchValue'),
  volume: $('#volume'),
  volumeValue: $('#volumeValue'),
  testVoice: $('#testVoice'),
  factsList: $('#factsList'),
  factsEmpty: $('#factsEmpty'),
  notesWrap: $('#notesWrap'),
  notesList: $('#notesList'),
  clearConversation: $('#clearConversation'),
  resetAll: $('#resetAll'),
};

/* ───────────────────────────── persistence ───────────────────────────── */

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.settings) {
      parsed.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...parsed.settings,
        voice: { ...DEFAULT_SETTINGS.voice, ...(parsed.settings.voice || {}) },
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveState() {
  if (!state.hydrated) return;
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        messages: state.messages.slice(-120),
        settings: state.settings,
        facts: state.facts.slice(-80),
        notes: state.notes.slice(-100),
      }),
    );
  } catch {
    /* quota — memory is best-effort */
  }
}

/* ───────────────────────────── notices ───────────────────────────── */

let noticeTimer = 0;

function showNotice(text) {
  ui.noticeText.textContent = text;
  ui.notice.hidden = false;
  clearTimeout(noticeTimer);
  // Long messages stay until dismissed; short ones fade after a while.
  if (text.length < 90) noticeTimer = setTimeout(() => (ui.notice.hidden = true), 9000);
}

function hideNotice() {
  ui.notice.hidden = true;
  clearTimeout(noticeTimer);
}

/* ═════════════════════════════ SPEECH OUT ═════════════════════════════ */

const SpeechEngine = {
  voices: [],
  seen: new Set(),
  turn: 0,
  queue: [],
  watchdog: 0,
  audio: null,
  speaking: false,

  init() {
    if (!('speechSynthesis' in window)) {
      this.supported = false;
      return;
    }
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length) {
        this.voices = list;
        fillVoiceSelect();
        updateDiagnostics();
      }
    };
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    setTimeout(load, 900);
    setTimeout(load, 2500);
  },

  pick(voiceURI) {
    return pickVoice(this.voices, voiceURI);
  },

  setSpeaking(value) {
    if (this.speaking === value) return;
    this.speaking = value;
    state.speaking = value;
    onSpeakingChanged(value);
  },

  report(key, message) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    showNotice(message);
  },

  stop() {
    this.turn++;
    this.queue = [];
    clearTimeout(this.watchdog);
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* noop */
    }
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
      } catch {
        /* noop */
      }
    }
    this.setSpeaking(false);
  },

  async speak(raw) {
    const text = sanitizeForSpeech(raw);
    if (!text) return;
    this.stop();
    const turn = ++this.turn;
    const s = state.settings.voice;

    if (s.preferElevenLabs && state.health?.tts === 'elevenlabs') {
      const used = await this.speakEleven(text, turn);
      if (used) return;
      if (turn !== this.turn) return;
    }
    this.speakBrowser(text, turn);
  },

  async speakEleven(text, turn) {
    try {
      const res = await fetch(`${API}?action=tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (turn !== this.turn) return true;
      if (!res.ok) {
        if (res.status !== 501) {
          const json = await res.json().catch(() => ({}));
          this.report(
            `tts-${res.status}`,
            `The cinematic voice is unavailable (${json.message || res.status}). Falling back to the system voice.`,
          );
        }
        return false;
      }

      const blob = await res.blob();
      if (turn !== this.turn) return true;

      const url = URL.createObjectURL(blob);
      const audio = this.audio || new Audio();
      this.audio = audio;
      audio.src = url;
      audio.volume = state.settings.voice.volume;

      state.engine = 'elevenlabs';
      this.setSpeaking(true);
      updateDiagnostics();

      await new Promise((resolve) => {
        const done = () => {
          audio.onended = null;
          audio.onerror = null;
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onended = done;
        audio.onerror = () => {
          this.report('playback', 'Playback failed — falling back to the system voice.');
          done();
        };
        audio.play().catch(done);
      });

      if (turn === this.turn) this.setSpeaking(false);
      return true;
    } catch {
      return false;
    }
  },

  speakBrowser(text, turn) {
    const synth = window.speechSynthesis;
    if (!synth) {
      this.report('unsupported', 'This browser has no speech synthesis. Replies will be text only.');
      this.setSpeaking(false);
      return;
    }

    const s = state.settings.voice;
    const voice = this.pick(s.browserVoice);
    const chunks = chunkForSpeech(text);
    if (!chunks.length) return;

    try {
      synth.cancel();
      synth.resume();
    } catch {
      /* noop */
    }

    state.engine = 'browser';
    updateDiagnostics();
    this.setSpeaking(true);

    let index = 0;
    const next = () => {
      if (turn !== this.turn) return;
      if (index >= chunks.length) return this.setSpeaking(false);

      const utter = new SpeechSynthesisUtterance(chunks[index++]);
      if (voice) utter.voice = voice;
      utter.lang = voice?.lang || 'en-GB';
      utter.rate = s.rate;
      utter.pitch = s.pitch;
      utter.volume = s.volume;

      let advanced = false;
      const advance = () => {
        if (advanced || turn !== this.turn) return;
        advanced = true;
        clearTimeout(this.watchdog);
        setTimeout(next, 60);
      };

      utter.onend = advance;
      utter.onerror = (e) => {
        const err = e.error;
        if (err && err !== 'interrupted' && err !== 'canceled') {
          this.report(
            err,
            err === 'synthesis-failed' || err === 'not-allowed'
              ? 'No system voice is available on this device. Add an ELEVENLABS_API_KEY for the cinematic voice, or install a voice in your OS settings. Typing works regardless.'
              : `Speech engine reported: ${err}`,
          );
        }
        advance();
      };

      // Chrome occasionally forgets onend; the watchdog keeps the queue moving.
      const estimate = Math.min(20_000, 1_600 + (chunks[index - 1].length / s.rate) * 78);
      this.watchdog = setTimeout(advance, estimate);

      try {
        synth.speak(utter);
      } catch {
        advance();
      }
    };

    next();
  },
};

/* ═════════════════════════════ SPEECH IN ═════════════════════════════ */

const VoiceInput = {
  rec: null,
  wantOn: false,
  paused: false,
  oneShot: false,
  armedUntil: 0,
  errorStreak: 0,
  fatal: false,
  restartTimer: 0,

  get wakeWord() {
    return state.settings.wakeMode === 'always' ? null : 'jarvis';
  },

  init() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      state.recState = 'unsupported';
      syncChrome();
      return false;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = navigator.language || 'en-US';

    rec.onstart = () => {
      if (!this.wantOn) return;
      setRecState(now() < this.armedUntil ? 'armed' : 'listening');
    };

    rec.onresult = (ev) => this.handleResult(ev);

    rec.onerror = (ev) => {
      const code = ev.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.fatal = true;
        this.wantOn = false;
        setRecState('error');
        showNotice(
          'Microphone access is blocked. Allow it in your browser (padlock icon → Site settings) and reload.',
        );
        return;
      }
      if (code === 'no-speech' || code === 'aborted' || code === 'audio-capture') return;
      if (code === 'network') {
        this.errorStreak++;
        if (this.errorStreak === 3) {
          showNotice(
            'Speech recognition keeps losing its network connection — Chrome sends audio to Google for transcription. Check your connection.',
          );
        }
        return;
      }
      showNotice(`Speech recognition error: ${code}`);
    };

    rec.onend = () => {
      if (!this.wantOn || this.fatal || this.paused) {
        if (!this.paused) setRecState('off');
        return;
      }
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (!this.wantOn || this.paused) return;
        try {
          rec.start();
        } catch {
          /* already running */
        }
      }, 350);
    };

    this.rec = rec;
    return true;
  },

  handleResult(ev) {
    if (this.paused) return;
    this.errorStreak = 0;

    let finalText = '';
    let interimText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) finalText += text + ' ';
      else interimText += text + ' ';
    }
    finalText = finalText.trim();
    interimText = interimText.trim();

    const wake = this.wakeWord;
    const wakeActive = !!wake;
    const hasWake = (text) =>
      !wakeActive || new RegExp(`\\b${wake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    const strip = (text) => {
      if (!wakeActive) return text;
      const idx = text.toLowerCase().indexOf(wake);
      return idx === -1 ? text : text.slice(idx + wake.length).replace(/^[\s,.:;!?-]+/, '').trim();
    };

    if (interimText) {
      state.interim = strip(interimText);
      renderInterim();
      if (hasWake(interimText) && !strip(interimText)) setRecState('armed');
    }

    if (!finalText) return;
    state.interim = '';
    renderInterim();

    // Push-to-talk: the wake word is irrelevant.
    if (this.oneShot) {
      this.oneShot = false;
      this.armedUntil = 0;
      const said = strip(finalText) || finalText;
      if (!FILLERS.test(said)) handleUtterance(said, 'voice');
      return;
    }

    const heardWake = hasWake(finalText);
    const armed = now() < this.armedUntil;
    const body = strip(finalText);

    if (wakeActive && heardWake) {
      if (body && !FILLERS.test(body)) {
        this.armedUntil = 0;
        handleUtterance(body, 'voice');
        return;
      }
      // Just "Jarvis." — open the window and wait for the request.
      this.armedUntil = now() + ARM_WINDOW_MS;
      setRecState('armed');
      return;
    }

    if (!wakeActive || armed) {
      this.armedUntil = 0;
      if (!FILLERS.test(finalText)) handleUtterance(finalText, 'voice');
    }
    // Otherwise: unaddressed speech, ignored.
  },

  start() {
    if (!this.rec || this.fatal) return;
    this.wantOn = true;
    this.paused = false;
    try {
      this.rec.start();
    } catch {
      /* already started */
    }
  },

  stop() {
    this.wantOn = false;
    this.oneShot = false;
    this.armedUntil = 0;
    setRecState('off');
    try {
      this.rec?.stop();
    } catch {
      /* noop */
    }
  },

  pause() {
    this.paused = true;
    try {
      this.rec?.abort();
    } catch {
      /* noop */
    }
  },

  resume() {
    this.paused = false;
    if (!this.wantOn) return;
    try {
      this.rec?.start();
    } catch {
      /* noop */
    }
  },

  listenOnce() {
    if (!this.rec || this.fatal) return;
    this.oneShot = true;
    this.paused = false;
    this.armedUntil = now() + ARM_WINDOW_MS;
    this.wantOn = true;
    setRecState('listening');
    try {
      this.rec.start();
    } catch {
      /* already running — the gate is open */
    }
  },
};

function setRecState(next) {
  if (state.recState === next) return;
  state.recState = next;
  syncChrome();
  if (next === 'listening' || next === 'armed') startMicLevel();
  else if (next === 'off' || next === 'error' || next === 'unsupported') stopMicLevel();
}

/* ═════════════════════════════ MIC LEVEL ═════════════════════════════ */

const mic = { level: 0, smooth: 0, stream: null, ctx: null, raf: 0, starting: false };

async function startMicLevel() {
  if (mic.stream || mic.starting || !navigator.mediaDevices?.getUserMedia) return;
  mic.starting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!(state.recState === 'listening' || state.recState === 'armed')) {
      stream.getTracks().forEach((t) => t.stop());
      mic.starting = false;
      return;
    }
    mic.stream = stream;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    mic.ctx = new Ctx();
    const analyser = mic.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    mic.ctx.createMediaStreamSource(stream).connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!mic.ctx) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      mic.level = Math.min(1, rms * 4.2);
      mic.raf = requestAnimationFrame(tick);
    };
    mic.raf = requestAnimationFrame(tick);
  } catch {
    /* permission denied — the reactor animates synthetically */
  } finally {
    mic.starting = false;
  }
}

function stopMicLevel() {
  cancelAnimationFrame(mic.raf);
  mic.raf = 0;
  mic.level = 0;
  mic.smooth = 0;
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.stream = null;
  mic.ctx?.close().catch(() => {});
  mic.ctx = null;
}

/* ═════════════════════════════ REACTOR ═════════════════════════════ */

function buildReactor() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = ui.reactorSvg;
  const r2 = (n) => Math.round(n * 100) / 100;
  const pt = (radius, angle) => ({ x: r2(200 + Math.cos(angle) * radius), y: r2(200 + Math.sin(angle) * radius) });

  const make = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  svg.innerHTML = `
    <defs>
      <radialGradient id="coreGrad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.98"/>
        <stop offset="32%" stop-color="var(--accent-bright)" stop-opacity="0.92"/>
        <stop offset="68%" stop-color="var(--accent)" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.5"/>
        <stop offset="55%" stop-color="var(--accent)" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="var(--accent-bright)" stop-opacity="0.9"/>
        <stop offset="50%" stop-color="var(--accent)" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="var(--accent-bright)" stop-opacity="0.85"/>
      </linearGradient>
      <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;

  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 190, fill: 'url(#glowGrad)' }));

  // outer hairline + rotating dashes
  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 186, class: 'ring ring--hairline' }));
  const spinSlow = make('g', { class: 'spin spin--slow' });
  spinSlow.appendChild(
    make('circle', { cx: 200, cy: 200, r: 173, class: 'ring ring--dashed', 'stroke-dasharray': '2 14' }),
  );
  svg.appendChild(spinSlow);

  // tick ring
  const ticks = make('g', { class: 'ticks' });
  for (let i = 0; i < 72; i++) {
    const angle = (i / 72) * Math.PI * 2;
    const major = i % 6 === 0;
    const inner = pt(major ? 148 : 155, angle);
    const outer = pt(165, angle);
    ticks.appendChild(
      make('line', {
        x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y,
        class: major ? 'tick tick--major' : 'tick',
      }),
    );
  }
  svg.appendChild(ticks);

  // counter-rotating segments
  const spinReverse = make('g', { class: 'spin spin--reverse' });
  for (let i = 0; i < 12; i++) {
    const len = (Math.PI * 2) / 12;
    const gap = 0.055;
    const from = pt(136, i * len + gap);
    const to = pt(136, (i + 1) * len - gap);
    spinReverse.appendChild(
      make('path', {
        d: `M ${from.x} ${from.y} A 136 136 0 0 1 ${to.x} ${to.y}`,
        class: i % 3 === 0 ? 'seg seg--bright' : 'seg',
      }),
    );
  }
  svg.appendChild(spinReverse);

  const spinMedium = make('g', { class: 'spin spin--medium' });
  spinMedium.appendChild(
    make('circle', { cx: 200, cy: 200, r: 118, class: 'ring ring--thin', 'stroke-dasharray': '40 12 8 12' }),
  );
  svg.appendChild(spinMedium);

  // housing + cage
  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 96, class: 'housing' }));
  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 96, class: 'ring ring--grad', stroke: 'url(#ringGrad)' }));

  const cage = make('g', { class: 'cage', filter: 'url(#softGlow)' });
  for (const deg of [0, 120, 240]) {
    const tip = pt(62, ((deg - 90) * Math.PI) / 180);
    const left = pt(44, ((deg + 30 - 90) * Math.PI) / 180);
    const right = pt(44, ((deg - 30 - 90) * Math.PI) / 180);
    cage.appendChild(
      make('path', {
        d: `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`,
        class: 'cage__blade',
      }),
    );
  }
  svg.appendChild(cage);

  // core
  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 82, fill: 'url(#coreGrad)', class: 'core' }));
  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 30, class: 'core__inner' }));
  svg.appendChild(make('circle', { cx: 200, cy: 200, r: 14, class: 'core__nucleus' }));

  // sonar sweep
  const spinFast = make('g', { class: 'spin spin--fast' });
  spinFast.appendChild(make('path', { d: 'M 200 200 L 200 104 A 96 96 0 0 1 268 132 Z', class: 'sweep' }));
  svg.appendChild(spinFast);
}

/* ═════════════════════════════ VISUALIZER ═════════════════════════════ */

const BARS = 56;

function startVisualizer() {
  const canvas = ui.visualizer;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let t = 0;
  const values = new Array(BARS).fill(0);
  const seed = Array.from({ length: BARS }, () => Math.random() * Math.PI * 2);
  let width = 0;
  let height = 0;

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  const styles = getComputedStyle(document.documentElement);
  const colourFor = (s) => {
    switch (s) {
      case 'listening':
      case 'armed':
        return styles.getPropertyValue('--accent-hot').trim() || '#8bf7ff';
      case 'thinking':
        return styles.getPropertyValue('--gold').trim() || '#ffc36b';
      case 'speaking':
        return styles.getPropertyValue('--accent-bright').trim() || '#bff4ff';
      case 'error':
        return styles.getPropertyValue('--danger').trim() || '#ff6b6b';
      default:
        return styles.getPropertyValue('--accent').trim() || '#4fd1ff';
    }
  };

  const draw = () => {
    requestAnimationFrame(draw);
    t += 0.045;

    const s = ui.reactor.dataset.state;
    const active = s === 'listening' || s === 'armed';
    const speaking = s === 'speaking';

    mic.smooth = mic.smooth * 0.8 + mic.level * 0.2;
    const level = clamp(mic.smooth, 0, 1);

    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const colour = colourFor(s);
    const barW = Math.max(2, (width / BARS) * 0.46);
    const gap = width / BARS;
    const baseAmp = height * 0.44;

    for (let i = 0; i < BARS; i++) {
      const phase = seed[i];
      const envelope = 0.35 + 0.65 * Math.sin(t * 0.7 + i * 0.28 + phase) ** 2;
      let target;

      if (active) target = baseAmp * (0.16 + envelope * (0.34 + level * 2.4));
      else if (speaking) target = baseAmp * (0.2 + envelope * (0.5 + Math.sin(t * 3 + phase) * 0.3));
      else if (s === 'thinking') target = baseAmp * (0.14 + envelope * 0.55 * (0.6 + Math.sin(t * 2.2 + i * 0.5) * 0.4));
      else target = baseAmp * (0.1 + envelope * 0.42);

      values[i] += (target - values[i]) * 0.22;
      const barH = Math.max(2.5, values[i]);
      const x = i * gap + (gap - barW) / 2;
      const y = mid - barH / 2;

      ctx.fillStyle = colour;
      ctx.globalAlpha = active || speaking ? 0.55 + envelope * 0.45 : 0.4 + envelope * 0.35;
      ctx.shadowBlur = active || speaking ? 10 : 4;
      ctx.shadowColor = colour;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, barH, barW / 2);
      else ctx.rect(x, y, barW, barH);
      ctx.fill();

      ctx.globalAlpha = (active || speaking ? 0.55 : 0.4) * 0.18;
      ctx.beginPath();
      ctx.rect(x, mid - barH / 2 - 3, barW, 2);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.22;
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.5, colour);
    grad.addColorStop(1, 'transparent');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  draw();
}

/* ═════════════════════════════ RENDERING ═════════════════════════════ */

let renderedIds = '';

function renderTranscript() {
  const signature = state.messages.map((m) => `${m.id}:${m.content.length}`).join('|');
  if (signature === renderedIds) return;
  renderedIds = signature;

  const frag = document.createDocumentFragment();

  if (!state.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'transcript__empty';
    const title = document.createElement('p');
    title.className = 'transcript__empty-title';
    title.textContent = 'Standing by.';
    const body = document.createElement('p');
    body.append('Say ');
    const kbd = document.createElement('span');
    kbd.className = 'kbd';
    kbd.textContent = 'Jarvis';
    body.append(kbd, ' then your request — or type below. Try “what’s the weather”, ');
    body.append('“set a timer for ten minutes”, “remember that I take my coffee black”.');
    empty.append(title, body);
    frag.appendChild(empty);
  }

  for (const m of state.messages) {
    const isUser = m.role === 'user';
    const article = document.createElement('article');
    article.className = `msg ${isUser ? 'msg--user' : 'msg--jarvis'}`;
    article.dataset.id = m.id;

    const head = document.createElement('header');
    head.className = 'msg__head';

    const who = document.createElement('span');
    who.className = 'msg__who';
    who.textContent = isUser ? 'You' : 'J.A.R.V.I.S.';
    head.appendChild(who);

    if (m.tag && !isUser) {
      const tag = document.createElement('span');
      tag.className = 'msg__tag';
      tag.textContent = m.tag;
      head.appendChild(tag);
    }

    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = timeOf(m.at);
    head.appendChild(time);

    const body = document.createElement('div');
    body.className = 'msg__body';
    body.textContent = m.content || (m.id === state.streamingId ? '' : '…');
    if (m.id === state.streamingId) body.appendChild(caret());

    article.append(head, body);
    frag.appendChild(article);
  }

  ui.transcript.replaceChildren(frag);
  scrollToBottom();
}

function caret() {
  const span = document.createElement('span');
  span.className = 'caret';
  return span;
}

function patchStreaming(id, text) {
  renderedIds = ''; // content changed → allow a full rebuild later if needed
  const node = ui.transcript.querySelector(`[data-id="${id}"] .msg__body`);
  if (!node) {
    renderTranscript();
    return;
  }
  node.textContent = text;
  node.appendChild(caret());
  scrollToBottom();
}

let pendingInterim = null;

function renderInterim() {
  if (!state.interim) {
    if (pendingInterim) {
      pendingInterim.remove();
      pendingInterim = null;
    }
    return;
  }
  if (!pendingInterim) {
    pendingInterim = document.createElement('article');
    pendingInterim.className = 'msg msg--user msg--interim';
    const head = document.createElement('header');
    head.className = 'msg__head';
    const who = document.createElement('span');
    who.className = 'msg__who';
    who.textContent = 'You';
    const tag = document.createElement('span');
    tag.className = 'msg__tag';
    tag.textContent = 'hearing';
    head.append(who, tag);
    const body = document.createElement('div');
    body.className = 'msg__body';
    pendingInterim.append(head, body);
  }
  pendingInterim.querySelector('.msg__body').textContent = state.interim;
  if (!pendingInterim.isConnected) ui.transcript.appendChild(pendingInterim);
  scrollToBottom();
}

let pinned = true;

function scrollToBottom() {
  if (!pinned) return;
  requestAnimationFrame(() => {
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
  });
}

function syncChrome() {
  const s = reactorState();
  ui.reactor.dataset.state = s;
  ui.visualizer.dataset.state = s;
  ui.statusDot.className = `dot dot--${s}`;
  ui.statusLabel.textContent = statusLabel(s);

  const listening = state.recState === 'listening' || state.recState === 'armed';
  ui.micBtn.classList.toggle('icon-btn--live', listening);
  ui.micPulse.hidden = !listening;
  ui.stateLabel.textContent = state.recState === 'unsupported'
    ? 'no microphone support'
    : state.busy
      ? 'processing'
      : listening
        ? 'listening'
        : 'ready';
  ui.stateLabel.classList.toggle('is-live', listening);

  ui.input.placeholder = placeholder();

  const canSend = ui.input.value.trim().length > 0 && !state.busy;
  ui.sendBtn.disabled = !canSend;
  ui.stopBtn.hidden = !state.speaking;
  ui.micBtn.title = listening ? 'Listening — click to stop' : 'Speak to JARVIS';
}

function reactorState() {
  if (state.speaking) return 'speaking';
  if (state.busy) return 'thinking';
  if (state.recState === 'armed') return 'armed';
  if (state.recState === 'listening') return 'listening';
  if (state.recState === 'error') return 'error';
  return 'idle';
}

function statusLabel(s) {
  switch (s) {
    case 'speaking':
      return 'Responding';
    case 'thinking':
      return 'Processing';
    case 'armed':
    case 'listening':
      return 'Listening';
    case 'error':
      return 'Microphone blocked';
    default:
      return 'Standing by';
  }
}

function placeholder() {
  if (!state.health) return 'Initialising…';
  if (state.recState === 'armed') return 'Listening, sir…';
  if (state.recState === 'listening') return 'Speak, or type your command…';
  if (!state.health.llm) return 'Type a command — local systems only until an API key is added';
  return state.settings.wakeMode === 'manual'
    ? 'Type, or press Space to speak…'
    : 'Type your message, or say “Jarvis”…';
}

/* ───────────────────────────── settings UI ───────────────────────────── */

const WAKE_NOTES = {
  wake: 'Listens quietly; responds when it hears “Jarvis”.',
  always: 'Responds to every sentence it hears. Best with headphones.',
  manual: 'Microphone only open while you press the button or Space.',
};

function fillVoiceSelect() {
  const current = state.settings.voice.browserVoice;
  const options = rankVoices(SpeechEngine.voices);
  ui.voiceSelect.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto — best British male available';
  ui.voiceSelect.appendChild(auto);
  for (const v of options) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} · ${v.lang}${v.localService ? '' : ' (network)'}`;
    ui.voiceSelect.appendChild(opt);
  }
  ui.voiceSelect.value = current;
}

function applySettingsToUI() {
  const s = state.settings;
  for (const btn of ui.wakeModeSeg.querySelectorAll('.seg__btn')) {
    btn.classList.toggle('is-active', btn.dataset.mode === s.wakeMode);
  }
  ui.wakeModeNote.textContent = WAKE_NOTES[s.wakeMode] || '';
  ui.speakReplies.checked = s.speakReplies;
  ui.userTitle.value = s.userTitle;
  ui.preferEleven.checked = s.voice.preferElevenLabs;
  ui.rate.value = String(s.voice.rate);
  ui.pitch.value = String(s.voice.pitch);
  ui.volume.value = String(s.voice.volume);
  ui.rateValue.textContent = `${s.voice.rate.toFixed(2)}×`;
  ui.pitchValue.textContent = s.voice.pitch.toFixed(2);
  ui.volumeValue.textContent = `${Math.round(s.voice.volume * 100)}%`;
  ui.voiceSelect.value = s.voice.browserVoice;
  renderMemoryLists();
}

function renderMemoryLists() {
  ui.factsList.replaceChildren();
  for (const fact of state.facts) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = fact;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Forget ${fact}`);
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      state.facts = state.facts.filter((f) => f !== fact);
      saveState();
      renderMemoryLists();
    });
    li.append(span, btn);
    ui.factsList.appendChild(li);
  }
  ui.factsEmpty.hidden = state.facts.length > 0;

  ui.notesList.replaceChildren();
  for (const note of state.notes) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = note;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Delete note ${note}`);
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      state.notes = state.notes.filter((n) => n !== note);
      saveState();
      renderMemoryLists();
    });
    li.append(span, btn);
    ui.notesList.appendChild(li);
  }
  ui.notesWrap.hidden = state.notes.length === 0;
}

function updateDiagnostics() {
  const h = state.health;
  ui.diagCore.textContent = h ? (h.llm ? `${h.provider} · ${h.model}` : 'offline (no API key)') : 'checking…';
  ui.diagCore.className = h?.llm ? 'ok' : 'warn';
  ui.diagEngine.textContent = state.engine === 'elevenlabs' ? 'ElevenLabs (cinematic)' : 'browser synthesis';
  ui.diagEngine.className = state.engine === 'elevenlabs' ? 'ok' : '';
  ui.diagRecognition.textContent = state.recState === 'unsupported' ? 'unsupported — use Chrome, Edge or Safari' : 'available';
  ui.diagRecognition.className = state.recState === 'unsupported' ? 'warn' : 'ok';
  const voice = SpeechEngine.pick(state.settings.voice.browserVoice);
  ui.diagSystemVoice.textContent = describeVoice(voice);
  ui.noteNoKey.hidden = !!h?.llm;
  ui.noteNoTts.hidden = h?.tts !== 'browser';
}

/* ───────────────────────────── speech callbacks ───────────────────────────── */

function onSpeakingChanged(speaking) {
  syncChrome();
  if (speaking) {
    VoiceInput.pause();
  } else {
    setTimeout(() => VoiceInput.resume(), 250);
  }
}

/* ═════════════════════════════ CONVERSATION ═════════════════════════════ */

function pushMessage(role, content, extra = {}) {
  const message = { id: uid(), role, content, at: now(), ...extra };
  state.messages.push(message);
  renderTranscript();
  saveState();
  return message;
}

function say(text) {
  if (state.settings.speakReplies) SpeechEngine.speak(text);
}

function getCoords() {
  if (localCoords) return Promise.resolve(localCoords);
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        localCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        resolve(localCoords);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 7000, maximumAge: 600_000 },
    );
  });
}

function commandContext() {
  return {
    userTitle: state.settings.userTitle || 'sir',
    timezone: state.health?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    homeCity: state.health?.homeCity || null,
    facts: state.facts,
    notes: state.notes,
    addFact: (fact) => {
      if (!state.facts.includes(fact)) state.facts.push(fact);
      saveState();
      renderMemoryLists();
    },
    addNote: (note) => {
      state.notes.push(note);
      saveState();
      renderMemoryLists();
    },
    clearNotes: () => {
      state.notes = [];
      saveState();
      renderMemoryLists();
    },
    getCoords,
  };
}

function handleAction(action, ctxMessage) {
  switch (action.type) {
    case 'stop-speaking':
      SpeechEngine.stop();
      break;
    case 'open':
      window.open(action.url, '_blank', 'noopener,noreferrer');
      break;
    case 'wake-mode':
      state.settings.wakeMode = action.mode;
      applySettingsToUI();
      saveState();
      syncListeningMode();
      break;
    case 'clear-conversation':
      currentStream?.abort();
      state.messages = [ctxMessage];
      state.busy = false;
      state.streamingId = null;
      renderTranscript();
      saveState();
      break;
    case 'clear-facts':
      state.facts = [];
      saveState();
      renderMemoryLists();
      break;
    case 'timer':
      setTimeout(() => {
        const line = `Sir, your ${action.label} timer has elapsed.`;
        pushMessage('assistant', line, { local: true, tag: 'timer' });
        say(line);
      }, action.seconds * 1000);
      break;
    default:
      break;
  }
}

async function handleUtterance(raw, from) {
  const text = raw.trim();
  if (!text) return;

  if (state.busy) {
    showNotice('One moment, sir — I am still working on the last request.');
    return;
  }

  SpeechEngine.stop(); // talking over him silences him
  pushMessage('user', text, from === 'voice' ? { tag: 'voice' } : {});

  let local = null;
  try {
    local = await runCommand(text, commandContext());
  } catch {
    local = null;
  }

  if (local) {
    const message = pushMessage('assistant', local.reply, { local: true, tag: local.tag });
    if (local.action) handleAction(local.action, message);
    if (local.action?.type !== 'stop-speaking') say(local.reply);
    return;
  }

  await askModel(text);
}

async function askModel(latestUserText) {
  const assistantId = uid();
  state.messages.push({ id: assistantId, role: 'assistant', content: '', at: now() });
  state.streamingId = assistantId;
  state.busy = true;
  renderTranscript();
  syncChrome();

  // The user's turn is already in state — never send it twice.
  const prior = state.messages.filter((m) => m.id !== assistantId);
  const last = prior[prior.length - 1];
  const alreadyQueued = last && last.role === 'user' && last.content.trim() === latestUserText.trim();
  const history = (alreadyQueued ? prior : [...prior, { role: 'user', content: latestUserText }])
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }))
    .filter((m) => m.content.trim().length > 0);

  const controller = new AbortController();
  currentStream = controller;
  let acc = '';

  try {
    const res = await fetch(`${API}?action=chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: history,
        facts: state.facts,
        userTitle: state.settings.userTitle || 'sir',
        localTime: new Date().toLocaleString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const { t } = JSON.parse(line);
          if (typeof t === 'string' && t) {
            acc += t;
            const message = state.messages.find((m) => m.id === assistantId);
            if (message) message.content = acc;
            patchStreaming(assistantId, acc);
          }
        } catch {
          /* ignore malformed frame */
        }
      }
    }

    if (!acc.trim()) acc = 'I appear to have lost my train of thought, sir.';
    const message = state.messages.find((m) => m.id === assistantId);
    if (message) message.content = acc;
    state.streamingId = null;
    renderTranscript();
    saveState();
    say(acc);
  } catch (err) {
    const aborted = err.name === 'AbortError';
    const message = state.messages.find((m) => m.id === assistantId);
    if (message) {
      message.content = acc ||
        (aborted
          ? 'As you wish, sir.'
          : 'I am unable to reach my language core at the moment, sir. Local commands remain available.');
    }
    state.streamingId = null;
    renderTranscript();
    if (!aborted) say(message.content);
  } finally {
    state.busy = false;
    currentStream = null;
    syncChrome();
    saveState();
  }
}

/* ═════════════════════════════ ACTIVATION ═════════════════════════════ */

function syncListeningMode() {
  if (!state.activated || state.recState === 'unsupported') return;
  if (state.settings.wakeMode === 'manual') VoiceInput.stop();
  else VoiceInput.start();
}

async function activate() {
  if (state.activated) return;
  state.activated = true;
  ui.boot.hidden = true;
  hideNotice();

  if (state.settings.speakReplies) {
    SpeechEngine.speak(
      `Systems online. J.A.R.V.I.S. at your service, ${state.settings.userTitle || 'sir'}.`,
    );
  }

  if (state.settings.wakeMode !== 'manual' && state.recState !== 'unsupported') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      VoiceInput.start();
    } catch {
      showNotice('Microphone permission denied — you can still type to JARVIS.');
    }
  }
  syncChrome();
}

/* ═════════════════════════════ EVENT WIRING ═════════════════════════════ */

function toggleMic() {
  if (!state.activated) {
    activate();
    return;
  }
  if (state.settings.wakeMode === 'manual') {
    VoiceInput.listenOnce();
    return;
  }
  if (state.recState === 'off' || state.recState === 'error') VoiceInput.start();
  else VoiceInput.stop();
}

function wireComposer() {
  ui.input.addEventListener('input', () => {
    ui.input.style.height = '0px';
    ui.input.style.height = `${Math.min(140, Math.max(24, ui.input.scrollHeight))}px`;
    syncChrome();
  });

  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitText();
    }
  });

  ui.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submitText();
  });

  ui.micBtn.addEventListener('click', toggleMic);
  ui.stopBtn.addEventListener('click', () => SpeechEngine.stop());
  ui.dismissNotice.addEventListener('click', hideNotice);
}

function submitText() {
  const text = ui.input.value.trim();
  if (!text || state.busy) return;
  ui.input.value = '';
  ui.input.style.height = '24px';
  syncChrome();
  handleUtterance(text, 'text');
}

function wireSettings() {
  const open = () => {
    ui.panel.classList.add('is-open');
    ui.scrim.classList.add('is-open');
    ui.panel.setAttribute('aria-hidden', 'false');
    updateDiagnostics();
  };
  const close = () => {
    ui.panel.classList.remove('is-open');
    ui.scrim.classList.remove('is-open');
    ui.panel.setAttribute('aria-hidden', 'true');
  };

  ui.openSettings.addEventListener('click', open);
  ui.closeSettings.addEventListener('click', close);
  ui.scrim.addEventListener('click', close);

  ui.wakeModeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg__btn');
    if (!btn) return;
    state.settings.wakeMode = btn.dataset.mode;
    applySettingsToUI();
    saveState();
    syncListeningMode();
    syncChrome();
  });

  ui.speakReplies.addEventListener('change', () => {
    state.settings.speakReplies = ui.speakReplies.checked;
    if (!state.settings.speakReplies) SpeechEngine.stop();
    saveState();
  });

  ui.userTitle.addEventListener('input', () => {
    state.settings.userTitle = ui.userTitle.value.trim() || 'sir';
    saveState();
    syncChrome();
  });

  ui.preferEleven.addEventListener('change', () => {
    state.settings.voice.preferElevenLabs = ui.preferEleven.checked;
    saveState();
  });

  ui.voiceSelect.addEventListener('change', () => {
    state.settings.voice.browserVoice = ui.voiceSelect.value;
    saveState();
    updateDiagnostics();
  });

  const bindRange = (input, key, label, format) => {
    input.addEventListener('input', () => {
      state.settings.voice[key] = Number(input.value);
      label.textContent = format(Number(input.value));
      saveState();
    });
  };
  bindRange(ui.rate, 'rate', ui.rateValue, (v) => `${v.toFixed(2)}×`);
  bindRange(ui.pitch, 'pitch', ui.pitchValue, (v) => v.toFixed(2));
  bindRange(ui.volume, 'volume', ui.volumeValue, (v) => `${Math.round(v * 100)}%`);

  ui.testVoice.addEventListener('click', () => {
    const title = state.settings.userTitle || 'sir';
    SpeechEngine.speak(`Voice calibration, ${title}. This is how I shall sound when we speak.`);
  });

  ui.clearConversation.addEventListener('click', () => {
    currentStream?.abort();
    state.messages = [];
    state.busy = false;
    state.streamingId = null;
    renderTranscript();
    saveState();
    close();
  });

  ui.resetAll.addEventListener('click', () => {
    currentStream?.abort();
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* noop */
    }
    state.messages = [];
    state.facts = [];
    state.notes = [];
    state.settings = structuredClone(DEFAULT_SETTINGS);
    state.busy = false;
    state.streamingId = null;
    applySettingsToUI();
    renderTranscript();
    hideNotice();
    close();
    syncChrome();
  });
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing =
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

    if (e.key === 'Escape') {
      SpeechEngine.stop();
      ui.panel.classList.remove('is-open');
      ui.scrim.classList.remove('is-open');
      return;
    }
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!state.activated) activate();
      else if (state.speaking) SpeechEngine.stop();
      else VoiceInput.listenOnce();
    }
  });
}

function wireMisc() {
  ui.transcript.addEventListener('scroll', () => {
    pinned = ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 90;
  });

  ui.initialise.addEventListener('click', activate);
  ui.skipBoot.addEventListener('click', () => {
    state.activated = true;
    ui.boot.hidden = true;
  });

  const tick = () => {
    ui.clock.textContent = new Date().toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };
  tick();
  setInterval(tick, 1000);

  // Chrome pauses synthesis on tab switch; nudge it back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.speaking) {
      try {
        window.speechSynthesis.resume();
      } catch {
        /* noop */
      }
    }
  });
}

/* ═════════════════════════════ BOOT ═════════════════════════════ */

async function init() {
  buildReactor();
  startVisualizer();

  // restore memory
  const saved = loadState();
  if (saved) {
    state.messages = Array.isArray(saved.messages) ? saved.messages.slice(-120) : [];
    state.facts = Array.isArray(saved.facts) ? saved.facts : [];
    state.notes = Array.isArray(saved.notes) ? saved.notes : [];
    if (saved.settings) state.settings = saved.settings;
  }
  state.hydrated = true;

  SpeechEngine.init();

  const recognitionReady = VoiceInput.init();
  if (!recognitionReady) state.recState = 'unsupported';

  applySettingsToUI();
  renderTranscript();
  syncChrome();
  updateDiagnostics();

  wireComposer();
  wireSettings();
  wireKeyboard();
  wireMisc();

  // health: which brain and voice are configured
  try {
    const res = await fetch(`${API}?action=health`);
    const health = await res.json();
    state.health = health;
    if (!saved?.settings?.userTitle && health.userTitle) {
      state.settings.userTitle = health.userTitle;
      applySettingsToUI();
    }
    ui.providerLabel.textContent = health.llm ? `${health.provider} online` : 'offline core';
    ui.providerPill.classList.toggle('pill--warn', !health.llm);
  } catch {
    ui.providerLabel.textContent = 'offline';
    ui.providerPill.classList.add('pill--warn');
  }

  updateDiagnostics();
  syncChrome();
}

init();
