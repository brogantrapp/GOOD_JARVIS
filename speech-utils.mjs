/**
 * J.A.R.V.I.S. — text preparation and voice ranking.
 *
 * Pure functions, no DOM access at import time, so both the browser
 * (`app.js`) and the tests (`tests.mjs`) can use them.
 */

/** Text preparation and voice ranking for speech synthesis. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu;
/** Strip anything that sounds wrong when read aloud. */
export function sanitizeForSpeech(input) {
    let s = input;
    s = s.replace(/```[\s\S]*?```/g, ' … a code block, which I shall display rather than recite … ');
    s = s.replace(/`([^`]+)`/g, '$1');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    s = s.replace(/https?:\/\/\S+/gi, 'a link');
    s = s.replace(/[*_#>]+/g, '');
    s = s.replace(/^\s*[-•]\s*/gm, '');
    s = s.replace(/\|/g, ', ');
    s = s.replace(EMOJI, '');
    s = s.replace(/J\.?\s?A\.?\s?R\.?\s?V\.?\s?I\.?\s?S\.?/gi, 'Jarvis');
    s = s.replace(/\bAI\b/g, 'A.I.');
    s = s.replace(/&/g, ' and ');
    s = s.replace(/[–—]/g, ', ');
    s = s.replace(/\s*\n\s*/g, '. ');
    s = s.replace(/\.{3,}/g, '…');
    s = s.replace(/\s{2,}/g, ' ');
    s = s.replace(/\.\s*\./g, '.');
    s = s.trim();
    return s;
}
/** Split into speakable chunks — Chrome truncates long utterances. */
export function chunkForSpeech(text, max = 190) {
    if (text.length <= max)
        return text ? [text] : [];
    const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        if (!current) {
            current = sentence;
        }
        else if ((current + sentence).length <= max) {
            current += sentence;
        }
        else {
            chunks.push(current.trim());
            current = sentence;
        }
        // A single monster sentence: hard-split on commas/spaces.
        while (current.length > max) {
            let cut = current.lastIndexOf(',', max);
            if (cut < max * 0.4)
                cut = current.lastIndexOf(' ', max);
            if (cut <= 0)
                cut = max;
            chunks.push(current.slice(0, cut + 1).trim());
            current = current.slice(cut + 1);
        }
    }
    if (current.trim())
        chunks.push(current.trim());
    return chunks.filter(Boolean);
}
/* ───────────────────────── voice selection ───────────────────────── */
const BRITISH_MALE_NAMES = [
    'daniel',
    'arthur',
    'oliver',
    'george',
    'ryan',
    'guy',
    'thomas',
    'james',
    'male',
    'google uk english male',
];
const PREFERRED_EXACT = [
    'Google UK English Male',
    'Microsoft Ryan Online (Natural) - English (United Kingdom)',
    'Microsoft George - English (United Kingdom)',
    'Microsoft Thomas - English (United Kingdom)',
    'Daniel',
    'Arthur',
    'Oliver',
    'Microsoft Guy Online (Natural) - English (United States)',
];
export function scoreVoice(v) {
    let score = 0;
    const name = v.name.toLowerCase();
    const lang = v.lang.toLowerCase().replace('_', '-');
    if (lang === 'en-gb')
        score += 100;
    else if (lang.startsWith('en-gb'))
        score += 95;
    else if (lang === 'en-au' || lang === 'en-nz' || lang === 'en-ie' || lang === 'en-za')
        score += 45;
    else if (lang.startsWith('en'))
        score += 30;
    else
        score -= 40;
    if (PREFERRED_EXACT.some((p) => p.toLowerCase() === name))
        score += 60;
    for (const n of BRITISH_MALE_NAMES)
        if (name.includes(n))
            score += 18;
    if (/(female|samantha|victoria|karen|moira|tessa|fiona|serena|kate|sonia|libby|aria|jenny|zira|susan|hazel)/.test(name)) {
        score -= 55;
    }
    if (name.includes('natural') || name.includes('neural') || name.includes('premium') || name.includes('enhanced')) {
        score += 12;
    }
    if (!v.localService)
        score += 4;
    return score;
}
export function rankVoices(voices) {
    return [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
}
export function pickVoice(voices, preferredURI) {
    if (!voices.length)
        return null;
    if (preferredURI) {
        const exact = voices.find((v) => v.voiceURI === preferredURI);
        if (exact)
            return exact;
    }
    const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
    const pool = english.length ? english : voices;
    return rankVoices(pool)[0] || null;
}
/** Best guess at a "JARVIS-like" default voice for the settings hint. */
export function describeVoice(v) {
    if (!v)
        return 'No system voice available';
    return `${v.name} · ${v.lang}`;
}
