/**
 * Integration test for content.js: fake DOM + fake chrome API, real module code.
 *
 * Covers the regressions that made Alt+click look dead:
 *   - a real page fires pointerdown -> pointerup -> mousedown -> mouseup -> click
 *     for one physical click; all of them must be cancelled while Alt is held,
 *     and the list must receive exactly one toggle.
 *   - without Alt, none of them may be touched.
 *   - Alt must put the page in pick mode: class on <html>, and the element under
 *     the cursor gets data-xmp-hit (this is what draws the crosshair, since the
 *     page's own cursor rules win over anything set on <html>).
 *
 * Run: node test/content.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

await import(pathToFileURL(join(root, 'pick.core.js')).href);
check(Boolean(globalThis.XMPPick), 'pick.core.js exposes XMPPick');

// ---- fake DOM ---------------------------------------------------------------
function makeElement(tagName, props = {}) {
  const classes = new Set();
  const attrs = new Map();
  const el = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    textContent: '',
    style: {},
    dataset: {},
    attrs,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => {
        const value = on === undefined ? !classes.has(c) : Boolean(on);
        if (value) classes.add(c);
        else classes.delete(c);
        return value;
      },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    appendChild() {},
    attachShadow() {
      const box = { innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => ({ textContent: '', className: '' }) };
      this.shadowRoot = { innerHTML: '', getElementById: () => box };
      return this.shadowRoot;
    },
    ...props,
  };
  return el;
}

const listeners = new Map();
const add = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};

let topElement = null;
const metaMap = {};
const documentStub = {
  documentElement: makeElement('html'),
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: (tag) => makeElement(tag),
  addEventListener: add,
  elementFromPoint: () => topElement,
  querySelectorAll: () => [],
  querySelector: (sel) => (metaMap[sel] ? { getAttribute: (k) => (k === 'content' ? metaMap[sel] : null) } : null),
};

const windowStub = { addEventListener: add };

globalThis.document = documentStub;
globalThis.window = windowStub;
globalThis.location = { origin: 'https://x.com', pathname: '/' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
// Elements opt into a CSS background by carrying __bg in these tests.
globalThis.getComputedStyle = (node) => ({ backgroundImage: (node && node.__bg) || 'none' });

const sent = [];
let contentMessageListener = null;
const MANIFEST_VERSION = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).version;
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: MANIFEST_VERSION }),
    getURL: (path) => pathToFileURL(join(root, path)).href,
    onMessage: { addListener: (fn) => { contentMessageListener = fn; } },
    async sendMessage(message) {
      sent.push(message);
      return { ok: true, action: 'added', added: 1, removed: 0, count: sent.length, resolved: false, items: [message.item] };
    },
  },
};

await import(pathToFileURL(join(root, 'content.js')).href);
check(listeners.has('pointerdown'), 'content script listens on pointerdown');
check(listeners.has('pointermove'), 'content script listens on pointermove');
check(typeof contentMessageListener === 'function', 'content script answers xmp:ping');

function dispatch(type, target, { altKey, button = 0, clientX = 10, clientY = 10, key = '' }) {
  const event = {
    type,
    target,
    altKey,
    button,
    clientX,
    clientY,
    key,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
  };
  for (const handler of listeners.get(type) ?? []) handler(event);
  return event;
}

function physicalClick(target, opts) {
  return ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].map((type) => dispatch(type, target, opts));
}

const article = makeElement('article', {
  querySelector: (sel) => (sel.includes('/status/') ? { getAttribute: () => '/someone/status/1732824684683784516' } : null),
});

const photo = makeElement('img', {
  src: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small',
  currentSrc: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small',
  closest: (sel) => (sel.includes('img') || sel.includes('video') ? photo : null),
});

// 1. Alt enters pick mode and the element under the cursor is marked
topElement = photo;
dispatch('keydown', documentStub.documentElement, { altKey: true, key: 'Alt' });
check(documentStub.documentElement.classList.contains('__xmp-alt'), 'alt keydown puts <html> in pick mode');
dispatch('pointermove', photo, { altKey: true, clientX: 50, clientY: 60 });
await new Promise((r) => setTimeout(r, 20));
check(photo.getAttribute('data-xmp-hit') === '', 'pointermove marks the element for crosshair + outline', String(photo.getAttribute('data-xmp-hit')));

// 2. Alt+click a photo: whole gesture cancelled, exactly one toggle
sent.length = 0;
const gesture = physicalClick(photo, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(gesture[0].defaultPrevented, 'alt: pointerdown is cancelled (this is what stops X opening the viewer)');
check(gesture[0].propagationStopped, 'alt: pointerdown stops propagation before page handlers');
check(gesture[4].defaultPrevented, 'alt: click is cancelled too');
check(sent.length === 1, 'alt: exactly one toggle message for the whole gesture', `got ${sent.length}`);
check(sent[0]?.item?.url === 'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig', 'alt: message carries the orig URL', sent[0]?.item?.url);
check(sent[0]?.item?.kind === 'image', 'alt: message carries the kind', sent[0]?.item?.kind);

// 3. Plain click must be untouched, on every event of the gesture
sent.length = 0;
const plain = physicalClick(photo, { altKey: false });
await new Promise((r) => setTimeout(r, 40));
check(plain.every((e) => !e.defaultPrevented && !e.propagationStopped), 'plain click: nothing is cancelled');
check(sent.length === 0, 'plain click: sends nothing');

// 4. Alt+click a video poster -> post link, never the poster URL
const poster = makeElement('img', {
  src: 'https://pbs.twimg.com/ext_tw_video_thumb/9001/pu/img/p.jpg',
  currentSrc: 'https://pbs.twimg.com/ext_tw_video_thumb/9001/pu/img/p.jpg',
  closest: (sel) => (sel.includes('article') ? article : sel.includes('img') ? poster : null),
});
sent.length = 0;
physicalClick(poster, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent[0]?.item?.kind === 'post', 'poster resolves to the post, never to the poster URL', sent[0]?.item?.kind);
check(sent[0]?.item?.url === 'https://x.com/someone/status/1732824684683784516', 'post link is absolute', sent[0]?.item?.url);

// 5. Alt+click a blob video -> post link (background resolves it to an MP4)
const blobVideo = makeElement('video', {
  src: 'blob:https://x.com/1234',
  currentSrc: 'blob:https://x.com/1234',
  closest: (sel) => (sel.includes('article') ? article : sel.includes('video') ? blobVideo : null),
});
sent.length = 0;
physicalClick(blobVideo, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent[0]?.item?.kind === 'post', 'blob video resolves to the post', sent[0]?.item?.kind);

// 5b. The real X case: the clickable layer is a sibling of <video>, not a child.
//     Clicking it used to resolve to nothing, so only clicking elsewhere worked.
const playerWrapper = makeElement('div', {
  querySelector: (sel) => (sel === 'video' ? blobVideo : null),
  closest: () => null,
});
const overlay = makeElement('div', {
  closest: () => null,
  querySelector: () => null,
  parentElement: playerWrapper,
});
sent.length = 0;
physicalClick(overlay, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent.length === 1, 'overlay sibling of <video> still resolves (this is the video body)', `got ${sent.length}`);
check(sent[0]?.item?.kind === 'post', 'overlay click maps to the post that owns the video', sent[0]?.item?.kind);

// 5c. Empty area inside a post (avatar present) must stay a no-op, not grab the avatar
const emptyArea = makeElement('div', {
  closest: () => null,
  querySelector: () => null,
  parentElement: article,
});
sent.length = 0;
const emptyEvents = physicalClick(emptyArea, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent.length === 0, 'empty post area adds nothing', `got ${sent.length}`);
check(emptyEvents.every((e) => !e.defaultPrevented), 'empty post area is not cancelled');

// 6. Poster clicked outside any article: post id comes from the address bar
location.pathname = '/SpaceX/status/1732824684683784516';
const orphanPoster = makeElement('img', {
  src: 'https://pbs.twimg.com/ext_tw_video_thumb/9002/pu/img/p.jpg',
  currentSrc: 'https://pbs.twimg.com/ext_tw_video_thumb/9002/pu/img/p.jpg',
  closest: () => null,
  querySelector: () => null,
});
const anyAnchor = makeElement('a', { getAttribute: () => null, querySelector: () => null });
const proxied = makeElement('div', {
  closest: (sel) => (sel.includes('img') ? null : sel.includes('article') ? null : null),
  querySelector: () => orphanPoster,
});
sent.length = 0;
physicalClick(proxied, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent[0]?.item?.kind === 'post', 'orphan poster (fullscreen player) falls back to the URL post id', sent[0]?.item?.kind);
check(sent[0]?.item?.url === 'https://x.com/i/status/1732824684683784516', 'URL-derived post link is canonical', sent[0]?.item?.url);
location.pathname = '/';

// 7. Alt+click on non-media does nothing and does not block the page
const div = makeElement('div', { closest: () => null, querySelector: () => null });
sent.length = 0;
const nothing = physicalClick(div, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent.length === 0 && nothing.every((e) => !e.defaultPrevented), 'alt+click on non-media is left alone');

// 8. Two separate physical clicks are two toggles (add, then remove)
await new Promise((r) => setTimeout(r, 300));
sent.length = 0;
physicalClick(photo, { altKey: true });
await new Promise((r) => setTimeout(r, 20));
physicalClick(photo, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent.length === 2, 'two physical clicks produce two toggles (add then remove)', `got ${sent.length}`);

// 9. A keyboard-style click (no pointerdown) still toggles
await new Promise((r) => setTimeout(r, 300));
sent.length = 0;
dispatch('click', photo, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent.length === 1, 'click without pointerdown still toggles', `got ${sent.length}`);

// 9b. Generic site: a blob <video> whose page publishes og:video
const genericVideo = makeElement('video', {
  src: 'blob:https://example.com/abc',
  currentSrc: 'blob:https://example.com/abc',
  closest: (sel) => (sel === 'video' ? genericVideo : null),
});
metaMap['meta[property="og:video:secure_url"]'] = 'https://cdn.example.com/clip.mp4';
sent.length = 0;
physicalClick(genericVideo, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent[0]?.item?.kind === 'video', 'generic site: og:video is used when the element gives nothing', sent[0]?.item?.kind);
check(sent[0]?.item?.url === 'https://cdn.example.com/clip.mp4', 'generic site: uses the published stream URL', sent[0]?.item?.url);
delete metaMap['meta[property="og:video:secure_url"]'];

// 9c. Generic site: a block painted with a CSS background image
const bgBlock = makeElement('div', {
  closest: () => null,
  querySelector: () => null,
  __bg: 'url("https://cdn.example.com/cover.jpg")',
});
sent.length = 0;
physicalClick(bgBlock, { altKey: true });
await new Promise((r) => setTimeout(r, 40));
check(sent[0]?.item?.kind === 'image', 'css background: picked up as an image', sent[0]?.item?.kind);
check(sent[0]?.item?.url === 'https://cdn.example.com/cover.jpg', 'css background: url extracted', sent[0]?.item?.url);

// 10. Health ping tells the popup the script is alive
let pong = null;
contentMessageListener({ type: 'xmp:ping' }, {}, (r) => { pong = r; });
check(pong?.ok === true && pong.version === MANIFEST_VERSION, 'ping reports version', JSON.stringify(pong));

// 11. Releasing Alt leaves pick mode and clears the highlight
dispatch('keyup', documentStub.documentElement, { altKey: false, key: 'Alt' });
check(!documentStub.documentElement.classList.contains('__xmp-alt'), 'alt keyup leaves pick mode');
check(photo.getAttribute('data-xmp-hit') === null, 'alt keyup clears the highlight');

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
