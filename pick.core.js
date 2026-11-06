/* GENERATED from pick.js by tools/build-core.mjs — do not edit by hand. */
(function attachPick() {
  'use strict';
  /**
   * Pure logic for the Alt+click media picker. No DOM globals, no chrome APIs:
   * the content script passes duck-typed nodes in, tests pass plain objects.
   */

  const TWIMG_ASSET = /^https?:\/\/(pbs|video)\.twimg\.com\//i;
  const COVER_ART = /^https?:\/\/pbs\.twimg\.com\/(ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//i;
  const STATUS_LINK = /\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/i;

  /** image | video | hls | post | ephemeral | unknown */
  function classifyUrl(url) {
    const u = String(url ?? '').trim();
    if (!u) return 'unknown';
    if (/^blob:|^data:/i.test(u)) return 'ephemeral';
    if (/\.m3u8(\?|$)/i.test(u)) return 'hls';
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u)) return 'video';
    if (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(u)) return 'image';
    if (/pbs\.twimg\.com\/(media|profile_images|profile_banners)\//i.test(u)) return 'image';
    if (STATUS_LINK.test(u)) return 'post';
    return 'unknown';
  }

  function isCoverArt(url) {
    return COVER_ART.test(String(url ?? ''));
  }

  /** A 1x1 gif / inline data URL / "blank.gif": the real image lives elsewhere. */
  function isPlaceholder(url) {
    const u = String(url ?? '');
    if (!u) return true;
    if (/^data:image\/(gif|png|svg)/i.test(u) && u.length < 400) return true;
    return /(^|\/)(spacer|blank|placeholder|loading|pixel|1x1|transparent)\.(gif|png|svg|webp)(\?|$)/i.test(u);
  }

  /** The URL inside a CSS `background-image`, if there is one. */
  function backgroundUrl(cssText) {
    const m = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/i.exec(String(cssText ?? ''));
    return m ? m[2] : null;
  }

  /**
   * Ask X's image CDN for the untouched upload. `name=orig` is the original
   * resolution and the original container; `_400x400` is the largest avatar X keeps.
   */
  function upgradeTwimg(url) {
    const raw = String(url ?? '').trim();
    if (!TWIMG_ASSET.test(raw)) return raw;

    const media = /^(https?:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+)(?:\.(jpe?g|png|webp|gif))?(?:\?(.*))?$/i.exec(raw);
    if (media) {
      // `?format=png` carries the real container when the path has no extension.
      const fromQuery = /(?:^|&)format=([a-z0-9]+)/i.exec(media[3] ?? '')?.[1];
      const hinted = (fromQuery ?? media[2] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
      const ext = ['jpg', 'png', 'webp', 'gif', 'avif'].includes(hinted) ? hinted : 'jpg';
      return `${media[1]}?format=${ext}&name=orig`;
    }

    const avatar = /^(https?:\/\/pbs\.twimg\.com\/profile_images\/[^?]+?)(?:_(normal|bigger|mini|\d+x\d+))?\.(jpe?g|png|webp|gif)(?:\?.*)?$/i.exec(raw);
    if (avatar) {
      const ext = avatar[3].toLowerCase().replace('jpeg', 'jpg');
      return `${avatar[1]}_400x400.${ext}`;
    }

    return raw;
  }

  /** Highest-density entry of a srcset, or null. */
  function bestFromSrcset(srcset) {
    if (!srcset) return null;
    const parts = String(srcset)
      .split(',')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [url, descriptor = ''] = chunk.split(/\s+/);
        const w = /^(\d+)w$/i.exec(descriptor);
        const d = /^([\d.]+)x$/i.exec(descriptor);
        return { url, score: w ? Number(w[1]) : d ? Number(d[1]) * 1000 : 1 };
      })
      .filter((part) => part.url);
    if (parts.length === 0) return null;
    parts.sort((a, b) => b.score - a.score);
    return parts[0].url;
  }

  function densityScore(url) {
    const m = /[?&]name=(thumb|small|medium|large|orig|4096x4096|\d+x\d+)/i.exec(String(url ?? ''));
    if (!m) return 1;
    const key = m[1].toLowerCase();
    if (key === 'thumb') return 0.1;
    if (key === 'small') return 0.3;
    if (key === 'medium') return 0.5;
    if (key === 'large') return 0.8;
    return 1;
  }

  /**
   * Turn one clicked node into a list entry.
   * @returns {{kind: string, url: string, label?: string, reason?: string} | null}
   *   kind 'ephemeral' / 'cover' means the click was on something that cannot be
   *   downloaded directly; the caller should fall back to the enclosing post.
   */
  function describeNode(node) {
    if (!node) return null;
    const tag = String(node.tagName ?? '').toUpperCase();

    if (tag === 'VIDEO') {
      const src = node.currentSrc || node.src || childSource(node) || '';
      if (!src || /^blob:|^data:/i.test(src)) {
        return { kind: 'ephemeral', url: '', reason: 'video is a blob stream; use the post link instead' };
      }
      return { kind: classifyUrl(src), url: src };
    }

    if (tag === 'SOURCE') {
      const best = bestFromSrcset(node.srcset) || node.src || '';
      if (!best) return null;
      return { kind: classifyUrl(best), url: best };
    }

    if (tag === 'PICTURE') {
      const inner = childSource(node) || node.querySelector?.('img')?.src || '';
      return inner ? { kind: classifyUrl(inner), url: upgradeTwimg(inner) } : null;
    }

    if (tag === 'IMG') {
      // Lazy loaders park a 1x1 placeholder in src and keep the real URL in a
      // data-* attribute; that convention is what every major gallery uses.
      const lazy =
        node.getAttribute?.('data-src') ||
        node.getAttribute?.('data-original') ||
        node.getAttribute?.('data-lazy-src') ||
        node.getAttribute?.('data-full') ||
        '';
      const direct = node.currentSrc || node.src || '';
      const src = !direct || isPlaceholder(direct) ? lazy || direct : direct;
      if (!src || isPlaceholder(src)) return null;
      if (isCoverArt(src)) {
        return { kind: 'cover', url: src, reason: 'poster frame, not the video itself' };
      }
      const srcsetBest = node.srcset ? bestFromSrcset(node.srcset) : null;
      const chosen = srcsetBest && densityScore(srcsetBest) >= densityScore(src) ? srcsetBest : src;
      return { kind: classifyUrl(chosen), url: upgradeTwimg(chosen) };
    }

    if (tag === 'A') {
      const href = node.href || node.getAttribute?.('href') || '';
      const kind = classifyUrl(href);
      if (kind === 'image' || kind === 'video' || kind === 'hls') return { kind, url: upgradeTwimg(href) };
      if (kind === 'post') return { kind: 'post', url: href };
      return null;
    }

    return null;
  }

  function childSource(node) {
    const source = node.querySelector?.('source');
    return source ? source.src || bestFromSrcset(source.srcset) || '' : '';
  }

  /** Canonical form used as the list key: drops volatile query noise, keeps the media id. */
  function listKey(url) {
    const raw = String(url ?? '').trim();
    const media = /^https?:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)/i.exec(raw);
    if (media) return `twimg:media:${media[1]}`;
    const status = STATUS_LINK.exec(raw);
    if (status && /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(raw)) return `x:status:${status[1]}`;
    try {
      const u = new URL(raw);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname}${u.search}`;
    } catch {
      return raw;
    }
  }

  /** Pure toggle: same rule the background uses, so tests and runtime cannot drift. */
  function toggleEntry(list, item) {
    const items = Array.isArray(list) ? list.slice() : [];
    const key = listKey(item.url);
    const index = items.findIndex((entry) => listKey(entry.url) === key);
    if (index >= 0) {
      items.splice(index, 1);
      return { list: items, action: 'removed', index };
    }
    items.push({ ...item, addedAt: item.addedAt ?? 0 });
    return { list: items, action: 'added', index: items.length - 1 };
  }

  function humanBytes(n) {
    const bytes = Number(n) || 0;
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${Math.round(v * 10) / 10} ${units[i]}`;
  }

  function kindLabel(kind) {
    return (
      {
        image: '图片',
        video: '视频',
        gif: 'GIF',
        hls: 'HLS',
        post: '帖子',
        ephemeral: '流媒体',
        cover: '封面',
        unknown: '未知',
      }[kind] ?? kind
    );
  }


  globalThis.XMPPick = { classifyUrl, isCoverArt, isPlaceholder, backgroundUrl, upgradeTwimg, bestFromSrcset, describeNode, listKey, toggleEntry, humanBytes, kindLabel };
})();
