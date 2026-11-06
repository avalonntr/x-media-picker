/**
 * Resolver tests: post payload -> real media URL, with a stubbed network.
 *
 * Run: node test/resolve.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(root, 'resolve.js')).href);

const { resolveTweet, idFromUrl } = globalThis.XMPResolve;

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(String(url), opts);
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

// ---- id extraction ----------------------------------------------------------
check(idFromUrl('https://x.com/u/status/1732824684683784516') === '1732824684683784516', 'id: status link');
check(idFromUrl('https://twitter.com/i/status/1732824684683784516?s=20') === '1732824684683784516', 'id: /i/status with query');
check(idFromUrl('1732824684683784516') === '1732824684683784516', 'id: bare id');
check(idFromUrl('https://x.com/u') === null, 'id: profile has no id');

const VIDEO_TWEET = {
  __typename: 'Tweet',
  id_str: '1732824684683784516',
  mediaDetails: [
    {
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg',
      video_info: {
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x/pl/a.m3u8?tag=14' },
          { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/x/vid/480x270/low.mp4?tag=14' },
          { content_type: 'video/mp4', bitrate: 10368000, url: 'https://video.twimg.com/x/vid/1920x1080/high.mp4?tag=14' },
        ],
      },
    },
  ],
};

// 1. video post resolves to the top mp4, not the poster, not the m3u8
await withFetch(
  () => json(VIDEO_TWEET),
  async () => {
    const out = await resolveTweet('https://x.com/u/status/1732824684683784516');
    check(out.items.length === 1, 'video: one item', String(out.items.length));
    check(out.items[0].url === 'https://video.twimg.com/x/vid/1920x1080/high.mp4?tag=14', 'video: highest mp4 chosen', out.items[0].url);
    check(out.items[0].kind === 'video', 'video: kind', out.items[0].kind);
    check(out.items[0].width === 1920 && out.items[0].height === 1080, 'video: dimensions parsed');
    check(out.source === 'syndication', 'video: source', out.source);
  },
);

// 2. GIF post
const GIF_TWEET = {
  __typename: 'Tweet',
  mediaDetails: [
    {
      type: 'animated_gif',
      media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/2/pu/img/t.jpg',
      video_info: { variants: [{ content_type: 'video/mp4', bitrate: 0, url: 'https://video.twimg.com/tweet_video/2.mp4' }] },
    },
  ],
};
await withFetch(
  () => json(GIF_TWEET),
  async () => {
    const out = await resolveTweet('1732824684683784516');
    check(out.items[0].kind === 'gif', 'gif: labelled gif', out.items[0].kind);
    check(out.items[0].url === 'https://video.twimg.com/tweet_video/2.mp4', 'gif: mp4 url', out.items[0].url);
  },
);

// 3. Photo-only post still returns something usable
const PHOTO_TWEET = {
  __typename: 'Tweet',
  mediaDetails: [
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AAA?format=png&name=small' },
  ],
};
await withFetch(
  () => json(PHOTO_TWEET),
  async () => {
    const out = await resolveTweet('1732824684683784516');
    check(out.items[0].kind === 'image', 'photo: kind', out.items[0].kind);
    check(out.items[0].url === 'https://pbs.twimg.com/media/AAA?format=png&name=orig', 'photo: orig + real format', out.items[0].url);
  },
);

// 4. syndication fails -> fxtwitter answers
await withFetch(
  (url) => {
    if (url.includes('syndication')) return json({ error: 'not found' }, 404);
    return json({
      code: 200,
      tweet: {
        media: {
          all: [
            {
              type: 'video',
              url: 'https://video.twimg.com/amplify_video/9/vid/1280x720/a.mp4',
              formats: [
                { url: 'https://video.twimg.com/amplify_video/9/vid/640x360/b.mp4', container: 'mp4', bitrate: 832000 },
                { url: 'https://video.twimg.com/amplify_video/9/vid/1280x720/a.mp4', container: 'mp4', bitrate: 2176000 },
              ],
            },
          ],
        },
      },
    });
  },
  async () => {
    const out = await resolveTweet('1732824684683784516');
    check(out.source === 'fxtwitter', 'fallback: used fxtwitter', out.source);
    check(out.items[0].url.includes('1280x720'), 'fallback: highest rendition', out.items[0].url);
  },
);

// 5. both fail -> error naming both backends
await withFetch(
  () => json({}, 404),
  async () => {
    try {
      await resolveTweet('1732824684683784516');
      check(false, 'failure: throws');
    } catch (err) {
      check(/syndication/.test(err.message) && /fxtwitter/.test(err.message), 'failure: reports both backends', err.message);
    }
  },
);

// 6. no id at all
await withFetch(
  () => json({}),
  async () => {
    try {
      await resolveTweet('https://x.com/someuser');
      check(false, 'no id: throws');
    } catch (err) {
      check(/no status id/i.test(err.message), 'no id: clear error', err.message);
    }
  },
);

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
