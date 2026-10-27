/* Static server for the end-to-end repro.
 *
 * The app page is served untouched except for one injected <script> tag, so the
 * test drives exactly the file that ships. Nothing here is test-aware beyond
 * that injection: the driver runs inside the real page, against the real
 * globals, with real contenteditable behaviour underneath it.
 *
 * The artifact is a fragment, and the publisher wraps it in a document with a
 * doctype. It is wrapped the same way here, or Blink would lay it out in quirks
 * mode and the colour and layout assertions would measure a page nobody sees.
 *
 * No dependencies on purpose — the page has no JS toolchain, and a repro that
 * needs one is a repro nobody runs.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel);
  // Nothing outside artifact/ is servable.
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file);
    let body = buf;
    if (rel === '/index.html') {
      body = Buffer.from(
        '<!doctype html>\n' + buf.toString('utf8') + '\n<script src="/tests/driver.js"></script>\n'
      );
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  });
});

server.listen(Number(process.argv[2]) || 8731, '127.0.0.1', () => {
  process.stdout.write('listening\n');
});
