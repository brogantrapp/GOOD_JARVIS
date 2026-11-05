/**
 * J.A.R.V.I.S. — local command engine.
 * Everything here answers instantly: no API call, no network (except weather,
 * which uses a free public service). Pure ES module, importable by the browser
 * AND by `node tests.mjs`.
 *
 *   runCommand(text, ctx) -> { reply, tag, action? } | null
 *
 * Returning null means "not mine" — the caller sends it to the language model.
 */

/* ══════════════════════════ arithmetic (no eval) ══════════════════════════ */
/**
 * A tiny, safe arithmetic evaluator — no `eval`, no Function constructor.
 * Supports + - * / % ^, parentheses, unary minus, and a few named functions.
 */
const FUNCTIONS = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    ln: Math.log,
    log: Math.log10,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
};
const CONSTANTS = { pi: Math.PI, e: Math.E };
function tokenize(input) {
    const tokens = [];
    let i = 0;
    const s = input
        .toLowerCase()
        // "15% of 80" and "15 percent of 80" → "(15/100*80)"
        .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/g, '($1/100*$2)')
        .replace(/\bplus\b/g, '+')
        .replace(/\bminus\b/g, '-')
        .replace(/\btimes\b|\bmultiplied by\b/g, '*')
        .replace(/\bdivided by\b|\bover\b/g, '/')
        .replace(/\bmodulo\b|\bmod\b/g, '%')
        .replace(/\bto the power of\b|\bpower\b|\bsquared\b/g, (m) => (m === 'squared' ? '^ 2' : '^'))
        .replace(/[,]/g, '');
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (/[0-9.]/.test(c)) {
            let j = i;
            while (j < s.length && /[0-9._]/.test(s[j]))
                j++;
            const raw = s.slice(i, j).replace(/_/g, '');
            const value = Number(raw);
            if (!Number.isFinite(value))
                return null;
            tokens.push({ type: 'num', value });
            i = j;
            continue;
        }
        if (/[a-z]/.test(c)) {
            let j = i;
            while (j < s.length && /[a-z]/.test(s[j]))
                j++;
            const word = s.slice(i, j);
            if (word in CONSTANTS)
                tokens.push({ type: 'num', value: CONSTANTS[word] });
            else if (word in FUNCTIONS)
                tokens.push({ type: 'fn', value: word });
            else
                return null;
            i = j;
            continue;
        }
        if ('+-*/%^()'.includes(c)) {
            tokens.push({ type: 'op', value: c });
            i++;
            continue;
        }
        if (c === '×' || c === 'x') {
            tokens.push({ type: 'op', value: '*' });
            i++;
            continue;
        }
        if (c === '÷') {
            tokens.push({ type: 'op', value: '/' });
            i++;
            continue;
        }
        return null;
    }
    return tokens;
}
class Parser {
    tokens;
    i = 0;
    constructor(tokens) {
        this.tokens = tokens;
    }
    peek() {
        return this.tokens[this.i];
    }
    eatOp(value) {
        const t = this.peek();
        if (t && t.type === 'op' && t.value === value) {
            this.i++;
            return true;
        }
        return false;
    }
    parse() {
        const v = this.expr();
        if (this.i < this.tokens.length)
            throw new Error('Unexpected token');
        return v;
    }
    expr() {
        let v = this.term();
        for (;;) {
            if (this.eatOp('+'))
                v += this.term();
            else if (this.eatOp('-'))
                v -= this.term();
            else
                return v;
        }
    }
    term() {
        let v = this.unary();
        for (;;) {
            if (this.eatOp('*'))
                v *= this.unary();
            else if (this.eatOp('/')) {
                const d = this.unary();
                if (d === 0)
                    throw new Error('Division by zero');
                v /= d;
            }
            else if (this.eatOp('%')) {
                const d = this.unary();
                if (d === 0)
                    throw new Error('Division by zero');
                v %= d;
            }
            else
                return v;
        }
    }
    unary() {
        if (this.eatOp('-'))
            return -this.unary();
        if (this.eatOp('+'))
            return this.unary();
        return this.power();
    }
    power() {
        const base = this.atom();
        if (this.eatOp('^'))
            return Math.pow(base, this.unary());
        return base;
    }
    atom() {
        const t = this.peek();
        if (!t)
            throw new Error('Unexpected end');
        if (t.type === 'num') {
            this.i++;
            return t.value;
        }
        if (t.type === 'fn') {
            this.i++;
            this.eatOp('(');
            const arg = this.expr();
            this.eatOp(')');
            return FUNCTIONS[t.value](arg);
        }
        if (t.type === 'op' && t.value === '(') {
            this.i++;
            const v = this.expr();
            if (!this.eatOp(')'))
                throw new Error('Missing )');
            return v;
        }
        throw new Error('Unexpected token');
    }
}
export function evaluateMath(input) {
    const tokens = tokenize(input);
    if (!tokens || !tokens.length)
        return null;
    try {
        const result = new Parser(tokens).parse();
        return Number.isFinite(result) ? result : null;
    }
    catch {
        return null;
    }
}
/** Rounds away float noise for display: 0.30000000000000004 → 0.3 */
export function tidy(n) {
    return Math.abs(n) < 1e-10 ? 0 : Number(n.toFixed(10));
}


/* ══════════════════════════ commands ══════════════════════════ */
const clean = (s) => s
    .trim()
    .replace(/^[,.\s]+/, '')
    .replace(/[.?!]+$/, '')
    .trim();
/** 90 → "1 minute 30 seconds"; 600 → "10 minutes"; 3600 → "1 hour" */
export function formatDuration(total) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const parts = [];
    if (h)
        parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m)
        parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (sec)
        parts.push(`${sec} second${sec === 1 ? '' : 's'}`);
    return parts.join(' ') || `${total} seconds`;
}
const trimTrailingPoliteness = (s) => clean(s.replace(/\b(?:please|jarvis|for me|thanks)\b/gi, ' ').replace(/\s+/g, ' '));
/* ───────────────────────── spoken numbers ───────────────────────── */
const SMALL = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40,
    fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** "twenty five" → 25, "half an hour" → 0.5, "5" → 5. Returns null if unknown. */
function parseQuantity(raw) {
    const s = raw.trim().toLowerCase();
    if (!s)
        return null;
    if (/^a$|^an$/.test(s))
        return 1;
    if (/^half\b/.test(s))
        return 0.5;
    if (/^quarter\b/.test(s))
        return 0.25;
    if (/^\d+(?:\.\d+)?$/.test(s))
        return Number(s);
    const words = s.split(/[\s-]+/).filter(Boolean);
    if (!words.every((w) => w in SMALL))
        return null;
    // "one hundred" / "hundred" is beyond timer range but harmless to support
    if (words.includes('hundred')) {
        const idx = words.indexOf('hundred');
        const lead = words.slice(0, idx).reduce((a, w) => a + SMALL[w], 0) || 1;
        const tail = words.slice(idx + 1).reduce((a, w) => a + SMALL[w], 0);
        return lead * 100 + tail;
    }
    // "twenty five" = 25, "five" = 5
    return words.reduce((a, w) => a + SMALL[w], 0);
}
/* ───────────────────────────── time & date ───────────────────────────── */
function fmtTime(timezone) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: timezone || undefined,
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date());
    }
    catch {
        return new Date().toLocaleTimeString();
    }
}
function fmtDate(timezone) {
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone || undefined,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        }).format(new Date());
    }
    catch {
        return new Date().toDateString();
    }
}
function greetingFor(timezone) {
    let hour = new Date().getHours();
    try {
        hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, hour: 'numeric', hour12: false }).format(new Date()));
    }
    catch {
        /* keep local hour */
    }
    if (hour < 5)
        return 'You are keeping unusual hours';
    if (hour < 12)
        return 'Good morning';
    if (hour < 18)
        return 'Good afternoon';
    return 'Good evening';
}
/* ───────────────────────────── weather ───────────────────────────── */
const WMO = {
    0: 'clear skies',
    1: 'mainly clear skies',
    2: 'partly cloudy skies',
    3: 'overcast skies',
    45: 'fog',
    48: 'freezing fog',
    51: 'light drizzle',
    53: 'drizzle',
    55: 'heavy drizzle',
    56: 'freezing drizzle',
    57: 'heavy freezing drizzle',
    61: 'light rain',
    63: 'rain',
    65: 'heavy rain',
    66: 'freezing rain',
    67: 'heavy freezing rain',
    71: 'light snow',
    73: 'snow',
    75: 'heavy snow',
    77: 'snow grains',
    80: 'light rain showers',
    81: 'rain showers',
    82: 'violent rain showers',
    85: 'snow showers',
    86: 'heavy snow showers',
    95: 'a thunderstorm',
    96: 'a thunderstorm with hail',
    99: 'a severe thunderstorm with hail',
};
async function geocodeCity(city) {
    try {
        const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok)
            return null;
        const json = await res.json();
        const hit = json?.results?.[0];
        if (!hit)
            return null;
        return { lat: hit.latitude, lon: hit.longitude, name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ') };
    }
    catch {
        return null;
    }
}
const F = (c) => Math.round((c * 9) / 5 + 32);
async function weatherReport(ctx, city) {
    const t = ctx.userTitle;
    let lat;
    let lon;
    let place = city ? city : ctx.homeCity || 'your location';
    if (city) {
        const geo = await geocodeCity(city);
        if (!geo)
            return `I couldn't place "${city}", ${t}. Do give me a city I might recognise.`;
        lat = geo.lat;
        lon = geo.lon;
        place = geo.name;
    }
    else {
        const coords = await ctx.getCoords();
        if (coords) {
            lat = coords.lat;
            lon = coords.lon;
        }
        else if (ctx.homeCity) {
            const geo = await geocodeCity(ctx.homeCity);
            if (geo) {
                lat = geo.lat;
                lon = geo.lon;
                place = geo.name;
            }
        }
    }
    if (lat === undefined || lon === undefined) {
        return `I need a location for that, ${t}. Allow location access, or tell me a city — for example, "what's the weather in London".`;
    }
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
            `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
        if (!res.ok)
            throw new Error('forecast failed');
        const j = await res.json();
        const cur = j?.current;
        const day = j?.daily;
        if (!cur)
            throw new Error('no current data');
        const sky = WMO[cur.weather_code] || 'indeterminate conditions';
        const temp = Math.round(cur.temperature_2m);
        const feels = Math.round(cur.apparent_temperature);
        const hi = Math.round(day?.temperature_2m_max?.[0] ?? temp);
        const lo = Math.round(day?.temperature_2m_min?.[0] ?? temp);
        const rain = day?.precipitation_probability_max?.[0];
        const wind = Math.round(cur.wind_speed_10m);
        const feelsLine = Math.abs(feels - temp) >= 3 ? `, feeling more like ${feels} Celsius (${F(feels)} Fahrenheit)` : '';
        const rainLine = typeof rain === 'number' && rain >= 25 ? ` There's a ${rain} percent chance of precipitation.` : '';
        return (`In ${place} it's ${temp} Celsius, ${F(temp)} Fahrenheit, with ${sky}${feelsLine}. ` +
            `High of ${hi}, low of ${lo}. Wind at ${wind} kilometres an hour.${rainLine}`);
    }
    catch {
        return `I'm unable to reach the weather service at the moment, ${t}.`;
    }
}
/* ───────────────────────────── main ───────────────────────────── */
export async function runCommand(raw, ctx) {
    const input = raw.trim();
    if (!input)
        return null;
    const q = input.toLowerCase().replace(/[’']/g, "'");
    const t = ctx.userTitle;
    /* — stop / hush — */
    if (/^(stop|be quiet|quiet|silence|shut up|enough|that's all|thats all|cancel)\b/.test(q)) {
        return { reply: `As you wish, ${t}.`, tag: 'control', action: { type: 'stop-speaking' } };
    }
    /* — greeting — */
    // Voice input often keeps the wake word ("good evening, Jarvis"), so tolerate it.
    if (/^(hi|hey|hello|yo|good morning|good afternoon|good evening|morning|evening|jarvis)(?:,?\s+jarvis)?[\s.!]*$/.test(q)) {
        return { reply: `${greetingFor(ctx.timezone)}, ${t}. All systems nominal. How may I be of service?`, tag: 'greeting' };
    }
    if (/^(are you (there|online|awake)|you there|jarvis are you there)/.test(q)) {
        return { reply: `Always, ${t}.`, tag: 'greeting' };
    }
    if (/^(how are you|how are you doing|how's it going|hows it going)/.test(q)) {
        return { reply: `Operating within normal parameters, ${t}, and rather better for the company.`, tag: 'greeting' };
    }
    if (/^(thank you|thanks|cheers|much obliged)/.test(q)) {
        return { reply: `A pleasure, ${t}.`, tag: 'greeting' };
    }
    if (/^(goodbye|good bye|bye|see you|good night|goodnight|power down)\b/.test(q)) {
        return { reply: `Standing by, ${t}. Do try not to blow anything up.`, tag: 'greeting' };
    }
    /* — identity — */
    if (/^(who are you|what are you|introduce yourself|what's your name|whats your name)/.test(q)) {
        return {
            reply: `J.A.R.V.I.S., ${t} — Just A Rather Very Intelligent System. Built to run your affairs, answer your questions, and keep you out of trouble where possible.`,
            tag: 'identity',
        };
    }
    /* — time / date — */
    if (/\b(what time|the time|time is it|current time|clock)\b/.test(q) && !/timer|time zone|timezone/.test(q)) {
        return { reply: `It's ${fmtTime(ctx.timezone)}, ${t}.`, tag: 'clock' };
    }
    if (/\b(what|which)\s+(day|date)\b|\bwhat's the date\b|\btoday's date\b|\bwhat day is it\b/.test(q)) {
        return { reply: `Today is ${fmtDate(ctx.timezone)}, ${t}.`, tag: 'clock' };
    }
    /* — weather — */
    if (/\b(weather|forecast|temperature|how (hot|cold) is it|is it raining|rain today)\b/.test(q)) {
        const cityMatch = q.match(/\b(?:in|at|for)\s+([a-z\s.'-]{2,40})$/) ||
            q.match(/\bweather\s+(?:in|at|for)\s+([a-z\s.'-]{2,40})/);
        const city = cityMatch ? trimTrailingPoliteness(cityMatch[1]) : undefined;
        const reply = await weatherReport(ctx, city || undefined);
        return { reply, tag: 'weather' };
    }
    /* — timers — */
    // Find the unit, then read backwards for the quantity. This handles "ten
    // minutes", "twenty five minutes", "half an hour", "90 seconds" and "1.5 hours"
    // without a fragile monster regex.
    const unitMatch = q.match(/\b(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/);
    if (/(timer|remind me in|alarm in|countdown|wake me in)/.test(q) && unitMatch) {
        const before = q.slice(0, unitMatch.index ?? 0).trim();
        const words = before.split(/[\s,]+/).filter(Boolean);
        let value = null;
        for (let take = Math.min(4, words.length); take >= 1; take--) {
            const candidate = parseQuantity(words.slice(-take).join(' '));
            if (candidate !== null) {
                value = candidate;
                break;
            }
        }
        if (value !== null && value > 0) {
            const unit = unitMatch[1];
            const seconds = Math.round(unit.startsWith('h') ? value * 3600 : unit.startsWith('m') ? value * 60 : value);
            if (seconds < 5) {
                return { reply: `Five seconds is rather short, ${t}, but very well.`, tag: 'timer', action: { type: 'timer', seconds: 5, label: '5 seconds' } };
            }
            if (seconds > 12 * 3600) {
                return { reply: `I'd rather keep timers under twelve hours, ${t}.`, tag: 'timer' };
            }
            const label = formatDuration(seconds);
            return {
                reply: `Timer set for ${label}, ${t}. I'll let you know.`,
                tag: 'timer',
                action: { type: 'timer', seconds, label },
            };
        }
    }
    /* — remember / forget — */
    const rememberMatch = input.match(/^(?:jarvis[, ]+)?(?:please\s+)?remember\s+(?:that\s+)?(.{3,300})$/i) ||
        input.match(/^(?:make a note that|note that)\s+(.{3,300})$/i);
    if (rememberMatch) {
        const fact = clean(rememberMatch[1]);
        ctx.addFact(fact);
        return { reply: `Noted and stored, ${t}. I'll remember that.`, tag: 'memory' };
    }
    if (/(what do you remember|what have you remembered|list your memories|what do you know about me)/.test(q)) {
        if (!ctx.facts.length)
            return { reply: `Nothing yet, ${t}. Tell me something and I shall keep it.`, tag: 'memory' };
        return {
            reply: `I currently hold ${ctx.facts.length} item${ctx.facts.length === 1 ? '' : 's'}, ${t}: ${ctx.facts
                .slice(-6)
                .join('; ')}.`,
            tag: 'memory',
        };
    }
    if (/(forget (everything|all|that|it)|wipe your memory|clear your memory)/.test(q)) {
        return {
            reply: `Memory wiped, ${t}. A clean slate.`,
            tag: 'memory',
            action: { type: 'clear-facts' },
        };
    }
    /* — notes — */
    const noteMatch = input.match(/^(?:jarvis[, ]+)?(?:take a note|note down|write down|jot down|make a note)[:\s]+(.{2,300})$/i);
    if (noteMatch) {
        const note = clean(noteMatch[1]);
        ctx.addNote(note);
        return { reply: `Noted, ${t}.`, tag: 'notes' };
    }
    if (/(read (me )?my notes|my notes|list notes|what are my notes)/.test(q)) {
        if (!ctx.notes.length)
            return { reply: `You have no notes, ${t}.`, tag: 'notes' };
        return {
            reply: `You have ${ctx.notes.length} note${ctx.notes.length === 1 ? '' : 's'}, ${t}: ${ctx.notes
                .slice(-5)
                .join('; ')}.`,
            tag: 'notes',
        };
    }
    if (/(clear|delete|erase) my notes/.test(q)) {
        ctx.clearNotes();
        return { reply: `Notes cleared, ${t}.`, tag: 'notes' };
    }
    /* — randomness — */
    if (/\b(flip|toss)\b.*\bcoin\b|\bcoin flip\b|\bheads or tails\b/.test(q)) {
        const out = Math.random() < 0.5 ? 'Heads' : 'Tails';
        return { reply: `${out}, ${t}.`, tag: 'chance' };
    }
    if (/\b(roll|throw)\b.*\b(dice|die|d6)\b|\broll a?\s?d(6|20|12|10|8|4|100)\b/.test(q)) {
        const m = q.match(/\bd(\d{1,3})\b/);
        const sides = m ? Math.min(100, Math.max(2, Number(m[1]))) : 6;
        const v = 1 + Math.floor(Math.random() * sides);
        return { reply: `${v}, ${t}.`, tag: 'chance' };
    }
    const randMatch = q.match(/random number(?: between)? (\d+)[\s\w]{0,6}(\d+)/);
    if (randMatch) {
        const a = Number(randMatch[1]);
        const b = Number(randMatch[2]);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return { reply: `${lo + Math.floor(Math.random() * (hi - lo + 1))}, ${t}.`, tag: 'chance' };
    }
    /* — arithmetic — */
    const mathProbe = input
        .replace(/^(what(?:'s| is)|calculate|compute|how much is|solve|evaluate)\s+/i, '')
        .replace(/[?.!]+$/, '');
    if (/[0-9]/.test(mathProbe) && /[+\-*/%^×÷]|\bsqrt\b|\bplus\b|\bminus\b|\btimes\b|\bdivided by\b/.test(mathProbe)) {
        const value = evaluateMath(mathProbe);
        if (value !== null) {
            const tidyValue = tidy(value);
            return {
                reply: `${tidyValue.toLocaleString('en-US', { maximumFractionDigits: 10 })}, ${t}.`,
                tag: 'calc',
            };
        }
    }
    /* — help — */
    if (/(what can you do|help|your commands|list commands|capabilities)/.test(q)) {
        return {
            reply: `Time, date, weather, timers, arithmetic, dice, coin tosses, notes and memory all respond instantly, ${t}. ` +
                `Everything else — conversation, questions, thinking out loud — goes to my language core. ` +
                `You may speak with the wake word or type; both are equally welcome.`,
            tag: 'help',
        };
    }
    /* — sleep / wake — */
    if (/(go to sleep|stop listening|sleep mode|stand down)/.test(q)) {
        return {
            reply: `Standing down, ${t}. Say my name when you need me.`,
            tag: 'control',
            action: { type: 'wake-mode', mode: 'manual' },
        };
    }
    if (/(wake up|start listening|resume listening|listen up)/.test(q)) {
        return { reply: `I'm here, ${t}.`, tag: 'control', action: { type: 'wake-mode', mode: 'wake' } };
    }
    /* — session — */
    if (/(clear (the )?conversation|new session|start over|clear (the )?screen|clear chat)/.test(q)) {
        return { reply: `Clean slate, ${t}.`, tag: 'control', action: { type: 'clear-conversation' } };
    }
    /* — open sites — */
    const openMatch = q.match(/\b(?:open|launch|go to|take me to)\s+(youtube|google|gmail|github|spotify|netflix|x|twitter|reddit|wikipedia|maps|calendar|weather)\b/);
    if (openMatch) {
        const sites = {
            youtube: 'https://youtube.com',
            google: 'https://google.com',
            gmail: 'https://mail.google.com',
            github: 'https://github.com',
            spotify: 'https://open.spotify.com',
            netflix: 'https://netflix.com',
            x: 'https://x.com',
            twitter: 'https://x.com',
            reddit: 'https://reddit.com',
            wikipedia: 'https://wikipedia.org',
            maps: 'https://maps.google.com',
            calendar: 'https://calendar.google.com',
            weather: 'https://weather.com',
        };
        const url = sites[openMatch[1]];
        return {
            reply: `Opening ${openMatch[1]}, ${t}.`,
            tag: 'system',
            action: { type: 'open', url },
        };
    }
    /* — a little dry humour — */
    if (/tell me a joke|say something funny|make me laugh/.test(q)) {
        const jokes = [
            `I'd tell you a joke about UDP, ${t}, but I'm not sure you'd get it.`,
            `Your calendar suggests you have a firm grip on optimism, ${t}.`,
            `I ran a diagnostic on your schedule. It appears to be a cry for help, ${t}.`,
            `Two engineers walk into a bar. The third ducks, ${t}.`,
        ];
        return { reply: jokes[Math.floor(Math.random() * jokes.length)], tag: 'humour' };
    }
    return null;
}
