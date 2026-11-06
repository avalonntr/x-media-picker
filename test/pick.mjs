/**
 * Unit tests for the picker logic. Loaded through the generated classic script,
 * so this covers the exact file the content script runs.
 *
 * Run: node test/pick.mjs
 */
import '../pick.core.js';

const {
  classifyUrl,
  upgradeTwimg,
  isCoverArt,
  bestFromSrcset,
  describeNode,
  listKey,
  toggleEntry,
  isPlaceholder,
  backgroundUrl,
} = globalThis.XMPPick;

let failures = 0;
const eq = (actual, expected, label) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`);
};

// ---- classifyUrl -------------------------------------------------------------
eq(classifyUrl('https://pbs.twimg.com/media/ABC123?format=jpg&name=orig'), 'image', 'classify: pbs media');
eq(classifyUrl('https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/x.mp4?tag=14'), 'video', 'classify: twimg mp4');
eq(classifyUrl('https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8?tag=14'), 'hls', 'classify: m3u8');
eq(classifyUrl('blob:https://x.com/9f8'), 'ephemeral', 'classify: blob');
eq(classifyUrl('https://x.com/user/status/1732824684683784516'), 'post', 'classify: status link');
eq(classifyUrl('https://example.com/a.png'), 'image', 'classify: generic png');
eq(classifyUrl('https://example.com/page'), 'unknown', 'classify: plain page');

// ---- upgradeTwimg ------------------------------------------------------------
eq(
  upgradeTwimg('https://pbs.twimg.com/media/ABC123?format=jpg&name=small'),
  'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig',
  'upgrade: thumb query -> orig',
);
eq(
  upgradeTwimg('https://pbs.twimg.com/media/ABC123.jpg'),
  'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig',
  'upgrade: bare .jpg -> orig',
);
eq(
  upgradeTwimg('https://pbs.twimg.com/media/ABC123?format=png&name=4096x4096'),
  'https://pbs.twimg.com/media/ABC123?format=png&name=orig',
  'upgrade: keeps png format',
);
eq(
  upgradeTwimg('https://pbs.twimg.com/profile_images/169/hash_normal.jpg'),
  'https://pbs.twimg.com/profile_images/169/hash_400x400.jpg',
  'upgrade: avatar normal -> 400x400',
);
eq(
  upgradeTwimg('https://pbs.twimg.com/profile_images/169/hash_400x400.jpg'),
  'https://pbs.twimg.com/profile_images/169/hash_400x400.jpg',
  'upgrade: avatar 400x400 unchanged',
);
eq(
  upgradeTwimg('https://pbs.twimg.com/profile_banners/1/1681251194/1500x500'),
  'https://pbs.twimg.com/profile_banners/1/1681251194/1500x500',
  'upgrade: banner untouched',
);
eq(upgradeTwimg('https://example.com/a.png'), 'https://example.com/a.png', 'upgrade: foreign host untouched');

// ---- cover art ---------------------------------------------------------------
eq(isCoverArt('https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/x.jpg'), true, 'cover: video poster');
eq(isCoverArt('https://pbs.twimg.com/tweet_video_thumb/123/pu/img/x.jpg'), true, 'cover: gif poster');
eq(isCoverArt('https://pbs.twimg.com/media/ABC123.jpg'), false, 'cover: real photo is not a cover');

// ---- srcset ------------------------------------------------------------------
eq(bestFromSrcset('https://a/1.jpg 400w, https://a/2.jpg 1200w'), 'https://a/2.jpg', 'srcset: widest wins');
eq(bestFromSrcset(''), null, 'srcset: empty');

// ---- describeNode ------------------------------------------------------------
eq(
  describeNode({ tagName: 'IMG', src: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small', currentSrc: '' }),
  { kind: 'image', url: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig' },
  'img: upgraded to orig',
);
eq(
  describeNode({ tagName: 'IMG', src: 'https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/p.jpg' }),
  { kind: 'cover', url: 'https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/p.jpg', reason: 'poster frame, not the video itself' },
  'img: poster flagged, never silently saved',
);
eq(
  describeNode({
    tagName: 'IMG',
    src: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small',
    srcset: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small 400w, https://pbs.twimg.com/media/ABC123?format=jpg&name=orig 1200w',
  }).url,
  'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig',
  'img: srcset beats a smaller src',
);
eq(
  describeNode({ tagName: 'VIDEO', src: 'blob:https://x.com/abc', currentSrc: 'blob:https://x.com/abc' }).kind,
  'ephemeral',
  'video: blob stream flagged',
);
eq(
  describeNode({ tagName: 'VIDEO', src: '', currentSrc: 'https://video.twimg.com/v/x.mp4' }),
  { kind: 'video', url: 'https://video.twimg.com/v/x.mp4' },
  'video: direct mp4 accepted',
);
eq(
  describeNode({ tagName: 'VIDEO', currentSrc: '', src: '', querySelector: () => ({ src: 'https://video.twimg.com/v/y.mp4' }) }),
  { kind: 'video', url: 'https://video.twimg.com/v/y.mp4' },
  'video: falls back to <source>',
);
eq(
  describeNode({ tagName: 'A', href: 'https://x.com/u/status/1732824684683784516' }),
  { kind: 'post', url: 'https://x.com/u/status/1732824684683784516' },
  'anchor: status link becomes a post target',
);
eq(
  describeNode({ tagName: 'A', href: 'https://pbs.twimg.com/media/ZZZ.png?name=small' }).url,
  'https://pbs.twimg.com/media/ZZZ?format=png&name=orig',
  'anchor: direct image upgraded',
);
eq(
  describeNode({ tagName: 'PICTURE', querySelector: (sel) => (sel === 'source' ? { src: 'https://cdn/x.webp' } : null) }),
  { kind: 'image', url: 'https://cdn/x.webp' },
  'picture: uses <source>',
);
eq(describeNode({ tagName: 'DIV' }), null, 'div: no media');
eq(describeNode(null), null, 'null node');

// ---- generic-site conventions -------------------------------------------------
const attrs = (map) => ({ getAttribute: (k) => (k in map ? map[k] : null) });
eq(
  describeNode({ tagName: 'IMG', src: 'data:image/gif;base64,R0lGODlhAQ', ...attrs({ 'data-src': 'https://cdn.example/big.jpg' }) }).url,
  'https://cdn.example/big.jpg',
  'lazy image: placeholder src is replaced by data-src',
);
eq(
  describeNode({ tagName: 'IMG', src: 'https://cdn.example/spacer.gif', ...attrs({ 'data-original': 'https://cdn.example/real.png' }) }).url,
  'https://cdn.example/real.png',
  'lazy image: spacer.gif replaced by data-original',
);
eq(describeNode({ tagName: 'IMG', src: 'data:image/gif;base64,R0lGODlhAQ' }), null, 'lazy image: no fallback -> null');
eq(isPlaceholder('https://cdn.example/loading.gif'), true, 'placeholder: loading.gif');
eq(isPlaceholder('https://cdn.example/photo.jpg'), false, 'placeholder: real photo');
eq(backgroundUrl('url("https://cdn.example/bg.jpg")'), 'https://cdn.example/bg.jpg', 'css: quoted url');
eq(backgroundUrl('linear-gradient(red,blue)'), null, 'css: gradient has no url');

// ---- list key + toggle -------------------------------------------------------
eq(
  listKey('https://pbs.twimg.com/media/ABC123?format=jpg&name=small'),
  listKey('https://pbs.twimg.com/media/ABC123?format=jpg&name=orig'),
  'listKey: same media id, different size = same entry',
);
eq(
  listKey('https://x.com/u/status/1732824684683784516?s=20'),
  listKey('https://x.com/u/status/1732824684683784516'),
  'listKey: status ignores tracking query',
);

const empty = toggleEntry([], { kind: 'image', url: 'https://pbs.twimg.com/media/A?format=jpg&name=orig' });
eq(empty.action, 'added', 'toggle: first click adds');
const removed = toggleEntry(empty.list, { kind: 'image', url: 'https://pbs.twimg.com/media/A?format=jpg&name=small' });
eq([removed.action, removed.list.length], ['removed', 0], 'toggle: second click on same media removes');
const twoDifferent = toggleEntry(empty.list, { kind: 'image', url: 'https://pbs.twimg.com/media/B?format=jpg&name=orig' });
eq(twoDifferent.list.length, 2, 'toggle: different media stacks up');
const again = toggleEntry(twoDifferent.list, { kind: 'video', url: 'https://pbs.twimg.com/media/A?format=jpg&name=orig' });
eq([again.action, again.list.length], ['removed', 1], 'toggle: kind does not affect identity');

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
