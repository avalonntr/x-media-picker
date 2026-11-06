/**
 * Background integration test — the exact complaint this version fixes:
 * Alt+click a blob video, and the list must end up holding a real MP4, not the
 * post link. Real background.js runs against a stubbed chrome API.
 *
 * Run: node test/background.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// ---- chrome stubs ------------------------------------------------------------
const store = new Map();
let messageListener = null;
let badgeText = '';

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: store.get(key) };
        return Object.fromEntries(store);
      },
      async set(patch) {
        for (const [k, v] of Object.entries(patch)) store.set(k, v);
      },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener: (fn) => { messageListener = fn; } },
  },
  action: {
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async ({ text }) => { badgeText = text; },
  },
  downloads: {
    onChanged: { addListener() {} },
    download: async () => 1,
  },
};

// ---- network stub ------------------------------------------------------------
const VIDEO_TWEET = {
  __typename: 'Tweet',
  id_str: '1732824684683784516',
  mediaDetails: [
    {
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/p.jpg',
      video_info: {
        variants: [
          { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/x/vid/480x270/low.mp4?tag=14' },
          { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/x/vid/1280x720/high.mp4?tag=14' },
        ],
      },
    },
  ],
};
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  if (String(url).includes('syndication')) {
    return { ok: true, status: 200, json: async () => VIDEO_TWEET, text: async () => JSON.stringify(VIDEO_TWEET) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};

await import(pathToFileURL(join(root, 'background.js')).href);
check(typeof messageListener === 'function', 'background registers a message listener');

function send(message) {
  return new Promise((resolve, reject) => {
    const keepOpen = messageListener(message, {}, (response) => resolve(response));
    if (keepOpen !== true) reject(new Error('listener did not keep the channel open'));
  });
}

// 1. Alt+click on a blob video arrives as {kind:'post'} -> must resolve to MP4
const first = await send({
  type: 'xmp:toggle',
  item: { kind: 'post', url: 'https://x.com/SpaceX/status/1732824684683784516', reason: 'video is a blob stream' },
});
check(first.ok === true, 'toggle: ok');
check(first.resolved === true, 'toggle: reported as resolved', String(first.resolved));
check(first.items?.[0]?.kind === 'video', 'toggle: list entry is a video', first.items?.[0]?.kind);
check(first.items?.[0]?.url === 'https://video.twimg.com/x/vid/1280x720/high.mp4?tag=14', 'toggle: list entry is the mp4', first.items?.[0]?.url);
check(first.count === 1, 'toggle: one item in the list', String(first.count));

const stored = (await chrome.storage.local.get('list')).list ?? [];
check(stored.length === 1 && /\.mp4/.test(stored[0].url), 'storage: holds the mp4, not the post link', JSON.stringify(stored.map((s) => s.url)));
check(!stored.some((s) => /\/status\//.test(s.url)), 'storage: no post link leaked into the list');
check(badgeText === '1', 'badge shows the count', badgeText);

// 2. Same click again removes it
const second = await send({
  type: 'xmp:toggle',
  item: { kind: 'post', url: 'https://x.com/SpaceX/status/1732824684683784516' },
});
check(second.action === 'removed' && second.removed === 1, 'toggle again removes', JSON.stringify(second));
check(((await chrome.storage.local.get('list')).list ?? []).length === 0, 'storage: empty after removal');

// 3. A direct image URL is stored as-is and never hits the network
const before = fetchCalls;
const third = await send({
  type: 'xmp:toggle',
  item: { kind: 'image', url: 'https://pbs.twimg.com/media/ZZZ?format=png&name=orig' },
});
check(fetchCalls === before, 'direct media: no resolve request', `${fetchCalls - before} calls`);
check(third.items?.[0]?.url === 'https://pbs.twimg.com/media/ZZZ?format=png&name=orig', 'direct media: stored unchanged');

// 4. A post that cannot be resolved falls back to the link, and says why
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{}' });
const fourth = await send({
  type: 'xmp:toggle',
  item: { kind: 'post', url: 'https://x.com/someone/status/1111111111111111111' },
});
check(fourth.resolved === false, 'unresolvable post: reported unresolved');
check(/syndication/.test(fourth.resolveError ?? ''), 'unresolvable post: reason kept', fourth.resolveError);
check((fourth.items ?? [])[0]?.kind === 'post', 'unresolvable post: falls back to the post entry');

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
