/* ═══════════════════════════════════════════════════════════════════════════
   Local development server — `node dev-server.js`

   Vercel doesn't need this file: it serves the static files and runs
   api/jarvis.js automatically. This is just so you can run the whole thing on
   your own machine with nothing installed:

       node dev-server.js          → http://localhost:3000

   It also loads .env.local if you have one, so your keys work locally.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ── tiny .env loader (no dependencies) ── */
for (const file of ['.env.local', '.env']) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const handler = require('./api/jarvis.js');

const PORT = Number(process.env.PORT || 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Everything under /api goes to the same function Vercel runs.
  if (url.pathname.startsWith('/api/')) {
    return handler(req, res);
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(__dirname, safe);

  if (!file.startsWith(__dirname)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  J.A.R.V.I.S. → http://localhost:${PORT}`);
  console.log(`  brain: ${process.env.GEMINI_API_KEY ? 'gemini' : process.env.GROQ_API_KEY ? 'groq' : process.env.OPENAI_API_KEY ? 'openai' : 'offline (no key in .env.local)'}\n`);
});
