/**
 * Service worker: owns the download list, the badge, and the browser downloads.
 * The list lives in chrome.storage.local under `list`.
 *
 * A `post` entry (what an Alt+click on a blob-streamed video yields) is resolved
 * here into the real MP4 before it reaches the list, so the list never shows a
 * post link where the user expected a video.
 */
import './pick.core.js';
import './resolve.js';

const { listKey, toggleEntry, upgradeTwimg } = globalThis.XMPPick;

const STORAGE_KEY = 'list';

async function readList() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function writeList(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
  await updateBadge(list.length);
}

async function updateBadge(count) {
  const n = Number(count) || 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text: n > 0 ? String(n > 99 ? '99+' : n) : '' });
}

chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge((await readList()).length);
});

chrome.runtime.onStartup?.addListener(async () => {
  await updateBadge((await readList()).length);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  updateBadge((changes[STORAGE_KEY].newValue ?? []).length);
});

/**
 * Alt+click arrives here. A direct media URL toggles as-is; a post link is
 * expanded into its real media first, and only falls back to the post link
 * itself when the post cannot be read.
 */
async function toggle(item) {
  if (!item?.url && !item?.tweetId) return { ok: false, error: 'no url' };

  let items = [{ ...item, addedAt: Date.now() }];
  let resolved = false;
  let source = null;
  let resolveError = null;

  if (item.kind === 'post' && item.resolve !== false) {
    const id = globalThis.XMPResolve.idFromUrl(item.url) ?? item.tweetId ?? null;
    if (!id) {
      resolveError = 'no status id in link';
    } else {
      try {
        const found = await globalThis.XMPResolve.resolveTweet(id);
        if (found.items.length > 0) {
          items = found.items.map((media) => ({ ...media, addedAt: Date.now(), fromPost: id }));
          resolved = true;
          source = found.source;
        }
      } catch (err) {
        resolveError = String(err?.message ?? err);
      }
    }
  }

  let list = await readList();
  let added = 0;
  let removed = 0;
  for (const entry of items) {
    const next = toggleEntry(list, entry);
    list = next.list;
    if (next.action === 'added') added += 1;
    else removed += 1;
  }
  await writeList(list);

  return {
    ok: true,
    action: added > 0 ? 'added' : 'removed',
    added,
    removed,
    count: list.length,
    resolved,
    source,
    resolveError,
    items: items.map((entry) => ({ kind: entry.kind, url: entry.url, width: entry.width, height: entry.height })),
  };
}

async function removeUrl(url) {
  const list = await readList();
  const key = listKey(url);
  const next = list.filter((entry) => listKey(entry.url) !== key);
  await writeList(next);
  return { ok: true, count: next.length };
}

async function clear() {
  await writeList([]);
  return { ok: true, count: 0 };
}

// ---- downloads -------------------------------------------------------------
// X's CDN occasionally 404s a `name=orig` request for very large images.
// One silent retry at `name=large` is better than handing the user an error.
const retried = new Map();

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== 'interrupted') return;
  const url = retried.get(delta.id);
  if (!url) return;
  retried.delete(delta.id);
  const downgraded = url.replace(/name=orig\b/, 'name=large');
  if (downgraded === url) return;
  try {
    await chrome.downloads.download({ url: downgraded, conflictAction: 'uniquify' });
  } catch {
    /* nothing else to try */
  }
});

async function downloadAll() {
  const list = await readList();
  const started = [];
  const skipped = [];
  for (const item of list) {
    if (!/^https?:/i.test(item.url ?? '')) {
      skipped.push(item);
      continue;
    }
    try {
      const id = await chrome.downloads.download({ url: item.url, conflictAction: 'uniquify' });
      if (/pbs\.twimg\.com\/media\/.+\bname=orig\b/.test(item.url)) retried.set(id, item.url);
      started.push({ id, url: item.url });
    } catch (err) {
      skipped.push({ ...item, error: String(err?.message ?? err) });
    }
  }
  return { ok: true, started: started.length, skipped };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'xmp:toggle':
          sendResponse(await toggle(message.item));
          break;
        case 'xmp:list':
          sendResponse({ ok: true, list: await readList() });
          break;
        case 'xmp:remove':
          sendResponse(await removeUrl(message.url));
          break;
        case 'xmp:clear':
          sendResponse(await clear());
          break;
        case 'xmp:download':
          sendResponse(await downloadAll());
          break;
        case 'xmp:resolve':
          sendResponse({ ok: true, ...(await globalThis.XMPResolve.resolveTweet(message.url)) });
          break;
        case 'xmp:upgrade':
          sendResponse({ ok: true, url: upgradeTwimg(message.url) });
          break;
        default:
          sendResponse({ ok: false, error: `unknown message ${message?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true; // keep the message channel open for the async reply
});
