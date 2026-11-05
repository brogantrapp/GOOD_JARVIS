/**
 * Tests for the parts of J.A.R.V.I.S. that don't need a browser.
 *
 *     node tests.mjs
 *
 * Covers the arithmetic parser, the local command engine, and the speech
 * text/voice helpers. No dependencies, no network.
 */

import { evaluateMath, tidy, runCommand, formatDuration } from './commands.mjs';
import { sanitizeForSpeech, chunkForSpeech, pickVoice, scoreVoice } from './speech-utils.mjs';

let pass = 0;
let fail = 0;

const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond, extra) => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
};
const section = (name) => console.log(`\n${name}`);

/* ── arithmetic ── */
section('arithmetic');
eq('precedence', evaluateMath('2+2*3'), 8);
eq('parentheses', evaluateMath('(2+3)^2'), 25);
eq('sqrt', evaluateMath('sqrt(16)'), 4);
eq('spoken words', evaluateMath('12 times 7'), 84);
eq('spoken division', evaluateMath('10 divided by 4'), 2.5);
eq('percent of', evaluateMath('15% of 80'), 12);
eq('unary minus', evaluateMath('-5+3'), -2);
eq('modulo', evaluateMath('50%8'), 2);
eq('division by zero', evaluateMath('5/0'), null);
eq('rejects prose', evaluateMath('hello there'), null);
eq('no eval: rejects injection', evaluateMath('alert(1)'), null);
eq('float tidy', tidy(0.1 + 0.2), 0.3);

/* ── local commands ── */
const facts = [];
const notes = [];
const ctx = {
  userTitle: 'sir',
  timezone: 'America/New_York',
  homeCity: 'Allentown',
  facts,
  notes,
  addFact: (f) => facts.push(f),
  addNote: (n) => notes.push(n),
  clearNotes: () => notes.splice(0),
  getCoords: async () => null,
};

const run = (q) => runCommand(q, ctx);

section('local commands');
{
  let r = await run('hello');
  ok('greeting addresses the user', /sir/.test(r?.reply ?? ''), r?.reply);
  eq('greeting tag', r?.tag, 'greeting');

  r = await run('what time is it?');
  ok('time', /^It's .*, sir\.$/.test(r?.reply ?? ''), r?.reply);

  r = await run("what's the date");
  ok('date', /^Today is .*, sir\.$/.test(r?.reply ?? ''), r?.reply);

  r = await run('flip a coin');
  ok('coin toss', /^(Heads|Tails), sir\.$/.test(r?.reply ?? ''), r?.reply);

  r = await run('roll a d20');
  ok('dice', /^\d+, sir\.$/.test(r?.reply ?? ''), r?.reply);

  r = await run('what is 12 * 7');
  eq('math command', r?.reply, '84, sir.');
  eq('math tag', r?.tag, 'calc');

  r = await run('remember that I take my coffee black');
  eq('fact stored', facts, ['I take my coffee black']);
  r = await run('what do you remember');
  ok('fact recalled', /coffee black/.test(r?.reply ?? ''), r?.reply);

  r = await run('take a note buy arc reactor parts');
  eq('note stored', notes, ['buy arc reactor parts']);

  eq('timer digits', (await run('set a timer for 5 minutes'))?.action, { type: 'timer', seconds: 300, label: '5 minutes' });
  eq('timer spoken', (await run('set a timer for ten minutes'))?.action, { type: 'timer', seconds: 600, label: '10 minutes' });
  eq('timer compound', (await run('set a timer for twenty five minutes'))?.action, { type: 'timer', seconds: 1500, label: '25 minutes' });
  eq('timer half hour', (await run('set a timer for half an hour'))?.action, { type: 'timer', seconds: 1800, label: '30 minutes' });
  eq('timer seconds label', (await run('set a timer for 90 seconds'))?.action, { type: 'timer', seconds: 90, label: '1 minute 30 seconds' });
  eq('nonsense timer falls through', await run('set a timer for banana minutes'), null);
  eq('duration format', formatDuration(5400), '1 hour 30 minutes');

  eq('stop action', (await run('stop'))?.action, { type: 'stop-speaking' });
  eq('sleep action', (await run('go to sleep'))?.action, { type: 'wake-mode', mode: 'manual' });
  eq('open site', (await run('open youtube'))?.action, { type: 'open', url: 'https://youtube.com' });
  eq('forget action', (await run('forget everything'))?.action, { type: 'clear-facts' });

  ok('identity', /J\.A\.R\.V\.I\.S\./.test((await run('who are you'))?.reply ?? ''));
  eq('general knowledge goes to the model', await run('explain the byzantine empire'), null);
}

/* ── speech helpers ── */
section('speech helpers');
eq('strips markdown', sanitizeForSpeech('**Hello** `sir`'), 'Hello sir');
eq('expands the acronym', sanitizeForSpeech('J.A.R.V.I.S. here'), 'Jarvis here');
eq('replaces links', sanitizeForSpeech('see https://example.com now'), 'see a link now');
ok('removes emoji', !/[🚀🔥]/u.test(sanitizeForSpeech('hello 🚀')));
ok('drops code blocks', /code block/.test(sanitizeForSpeech('```js\nlet x=1\n```')));

const chunks = chunkForSpeech('One. Two. Three. '.repeat(30), 190);
ok('chunks respect the limit', chunks.every((c) => c.length <= 200), chunks.map((c) => c.length));
ok('chunking loses nothing', chunks.join(' ').replace(/\s+/g, ' ').includes('Three.'));

const voices = [
  { name: 'Samantha', lang: 'en-US', voiceURI: 'a', localService: true },
  { name: 'Daniel', lang: 'en-GB', voiceURI: 'b', localService: true },
  { name: 'Google UK English Male', lang: 'en-GB', voiceURI: 'c', localService: false },
];
ok('British male ranks first', /Daniel|Google UK English Male/.test(pickVoice(voices, '')?.name ?? ''));
ok('score prefers en-GB male', scoreVoice(voices[2]) > scoreVoice(voices[0]));
ok('explicit choice honoured', pickVoice(voices, 'a')?.name === 'Samantha');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
