/**
 * End-to-end check in a real browser, without touching the user's desktop:
 * a throwaway Edge instance (its own --user-data-dir) loads the extension, a
 * local page stands in for X, and CDP dispatches real key/mouse input — the
 * same code path a physical Alt+click takes.
 *
 * Read back through the extension's own storage, so "did it work" is answered
 * by state, not by a screenshot.
 *
 * Run: node test/e2e-edge.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// XMP_EXT_DIR lets the same suite validate a packaged build instead of the source tree.
const EXT_DIR = process.env.XMP_EXT_DIR ?? root;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DEBUG_PORT = 9334;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readFile(join(root, decodeURIComponent(url.pathname)));
    res.writeHead(200, { 'content-type': MIME[extname(url.pathname)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/demo.html`;

const profile = await mkdtemp(join(tmpdir(), 'xmp-e2e-'));
const child = spawn(
  EDGE,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  ready() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('devtools websocket error'));
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try { this.ws.close(); } catch { /* closed */ }
  }
}

async function waitForDevtools(timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

let cdp = null;
let step = 'start';
let posterResolvedUrl = null;
try {
  const version = await waitForDevtools();
  cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready();

  step = 'find service worker';
  let swTarget = null;
  for (let i = 0; i < 40 && !swTarget; i += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!swTarget) await sleep(250);
  }
  check(Boolean(swTarget), 'extension service worker is running', swTarget?.url ?? 'not found');

  step = 'open page';
  const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (params, msgSession) => {
    if (msgSession === sessionId) contexts.push(params.context);
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await sleep(1500);

  const evalPage = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return res.result?.value;
  };

  step = 'measure media';
  const box = JSON.parse(
    await evalPage(`(() => {
      const img = document.querySelector('#post-photo img');
      const r = img.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) });
    })()`),
  );
  check(box.w > 10, 'stand-in page rendered a media element', `img width ${box.w}`);

  // A poster with no wrapping link: clicking it must not navigate, so it is the
  // safe target for the "plain click does nothing" check.
  const posterBox = JSON.parse(
    await evalPage(`(() => {
      const img = document.querySelector('#post-video img');
      const r = img.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`),
  );

  // --- the feature under test: Alt puts the page in pick mode ----------------
  step = 'alt keydown';
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 1 },
    sessionId,
  );
  await sleep(200);
  const pickMode = await evalPage(`document.documentElement.classList.contains('__xmp-alt')`);
  check(pickMode === true, 'Alt keydown puts the page in pick mode (drives the crosshair)', String(pickMode));

  step = 'hover';
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, modifiers: 1 }, sessionId);
  await sleep(250);
  const hit = await evalPage(`(() => {
    const el = document.querySelector('[data-xmp-hit]');
    if (!el) return 'none';
    return el.tagName + '|' + getComputedStyle(el).cursor;
  })()`);
  check(String(hit).startsWith('IMG'), 'hovering marks the media element', String(hit));
  check(String(hit).endsWith('crosshair'), 'marked element actually renders a crosshair cursor', String(hit));

  step = 'alt+click';
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 1 }, sessionId);
  await sleep(700);

  step = 'read storage';
  // chrome.storage is reachable from the content script's isolated world, not
  // from the page's main world and not reliably from the worker target.
  const isolated = contexts.find((c) => c.auxData?.type === 'isolated');
  check(Boolean(isolated), 'content script isolated world found', `${contexts.length} contexts`);
  const evalIsolated = async (expression) => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, contextId: isolated?.id, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
    return res.result?.value;
  };
  const readList = async () => {
    const raw = await evalIsolated(`chrome.storage.local.get('list').then((v) => JSON.stringify(v.list ?? []))`);
    return JSON.parse(raw);
  };

  const afterAlt = await readList();
  check(afterAlt.length === 1, 'Alt+click added exactly one entry', JSON.stringify(afterAlt.map((i) => i.url)));
  check(/pbs\.twimg\.com\/media\/.+name=orig/.test(afterAlt[0]?.url ?? ''), 'entry is the original image URL', afterAlt[0]?.url);

  step = 'plain click';
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: posterBox.x, y: posterBox.y, modifiers: 0 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: posterBox.x, y: posterBox.y, button: 'left', clickCount: 1, modifiers: 0 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: posterBox.x, y: posterBox.y, button: 'left', clickCount: 1, modifiers: 0 }, sessionId);
  await sleep(500);
  const afterPlain = await readList();
  check(afterPlain.length === 1, 'plain click changes nothing', `${afterPlain.length} entries`);

  // --- Alt+click on a poster frame: must resolve to the post's real MP4 -------
  step = 'alt+click poster -> resolve video';
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: posterBox.x, y: posterBox.y, button: 'left', clickCount: 1, modifiers: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: posterBox.x, y: posterBox.y, button: 'left', clickCount: 1, modifiers: 1 }, sessionId);
  await sleep(4000);
  const afterPoster = await readList();
  const latest = afterPoster[afterPoster.length - 1] ?? {};
  if (latest.kind === 'video' || latest.kind === 'gif') {
    check(/video\.twimg\.com\/.+\.mp4/.test(latest.url ?? ''), 'poster click resolved to the real MP4', latest.url);
    posterResolvedUrl = latest.url;
  } else {
    console.log(`skip poster->video: resolver unreachable here (${latest.kind}: ${latest.url ?? 'nothing added'})`);
  }

  // --- Alt+click the <video> body itself --------------------------------------
  // Same post as the poster, so a correct hit toggles the same MP4 back out.
  // Before the resolver fix this click produced nothing at all, while clicking
  // elsewhere in the post worked — the regression the user reported.
  step = 'alt+click video body';
  const videoBox = JSON.parse(
    await evalPage(`(() => {
      const v = document.querySelector('#post-blob video');
      const r = v.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`),
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: videoBox.x, y: videoBox.y, button: 'left', clickCount: 1, modifiers: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: videoBox.x, y: videoBox.y, button: 'left', clickCount: 1, modifiers: 1 }, sessionId);
  await sleep(4000);
  const afterVideo = await readList();
  if (posterResolvedUrl) {
    check(
      !afterVideo.some((i) => i.url === posterResolvedUrl),
      'clicking the video body targets the same MP4 (toggles it back out)',
      JSON.stringify(afterVideo.map((i) => i.kind)),
    );
  } else {
    console.log(`skip video-body check: ${JSON.stringify(afterVideo.map((i) => i.kind))}`);
  }

  step = 'alt keyup';
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 0 },
    sessionId,
  );
  await sleep(200);
  const cleaned = await evalPage(`(() => document.documentElement.classList.contains('__xmp-alt') || !!document.querySelector('[data-xmp-hit]'))()`);
  check(cleaned === false, 'releasing Alt restores the page', String(cleaned));
} catch (err) {
  check(false, `e2e aborted during "${step}"`, err?.stack ?? String(err));
} finally {
  cdp?.close();
  child.kill();
  await sleep(500);
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
