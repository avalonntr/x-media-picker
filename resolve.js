/**
 * Turns a post link into the actual media URL.
 *
 * Why this exists: X plays video through Media Source Extensions, so the
 * `<video>` element's src is `blob:https://x.com/...` and the browser's own
 * "copy video address" has nothing better to offer. The real MP4 lives in the
 * post payload, which is exactly what the single-post endpoints return.
 *
 * Used by the service worker (has host permissions, so no CORS barrier).
 * Attaches to globalThis so a plain script and a module SW can share it.
 */
(function attachResolve() {
  'use strict';

  const STATUS = /\/status(?:es)?\/(\d{5,25})/;
  const MP4 = /\.mp4(\?|$)/i;

  function idFromUrl(input) {
    const text = String(input ?? '');
    const fromPath = STATUS.exec(text);
    if (fromPath) return fromPath[1];
    if (/^\d{5,25}$/.test(text.trim())) return text.trim();
    return null;
  }

  function token(id) {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  }

  function resolution(url) {
    const m = /\/(\d{2,5})x(\d{2,5})(?:[./])/.exec(String(url));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
  }

  /** Highest progressive MP4 in a variant list; ties by bitrate, then pixels. */
  function bestMp4(variants) {
    const mp4 = (variants ?? [])
      .map((v) => ({
        url: v.url ?? v.src,
        type: v.content_type ?? v.type ?? v.container ?? '',
        bitrate: Number(v.bitrate ?? 0) || 0,
      }))
      .filter((v) => v.url && (MP4.test(v.url) || /mp4/i.test(v.type)))
      .map((v) => ({ ...v, ...resolution(v.url) }));
    if (mp4.length === 0) return null;
    mp4.sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate);
    return mp4[0];
  }

  function photoUrl(mediaUrl) {
    const raw = String(mediaUrl ?? '');
    const base = raw.split('?')[0].replace(/\.(jpe?g|png|webp|gif)$/i, '');
    // The container can arrive as a path extension or as `?format=`, never assume jpg.
    const fromQuery = /[?&]format=([a-z0-9]+)/i.exec(raw)?.[1];
    const fromPath = /\.(jpe?g|png|webp|gif)(?:\?|$)/i.exec(raw)?.[1];
    const ext = (fromQuery ?? fromPath ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
    return `${base}?format=${['jpg', 'png', 'webp', 'gif', 'avif'].includes(ext) ? ext : 'jpg'}&name=orig`;
  }

  /** Normalize one media entity from either backend. */
  function fromEntity(entity) {
    const type = String(entity?.type ?? entity?.kind ?? '').toLowerCase();
    if (type === 'photo' || type === 'image') {
      const url = entity.media_url_https ?? entity.url;
      return url ? { kind: 'image', url: photoUrl(url), width: 0, height: 0 } : null;
    }
    if (type === 'video' || type === 'animated_gif' || type === 'gif') {
      const best = bestMp4(entity.video_info?.variants ?? entity.variants ?? entity.formats);
      if (!best) return null;
      return {
        kind: type === 'video' ? 'video' : 'gif',
        url: best.url,
        width: best.width,
        height: best.height,
        bitrate: best.bitrate,
      };
    }
    return null;
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fromSyndication(id) {
    const json = await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token(id)}`);
    if (json?.__typename === 'TweetTombstone') throw new Error('tombstone');
    const entities = json?.mediaDetails ?? json?.photos ?? [];
    return entities.map(fromEntity).filter(Boolean);
  }

  async function fromFx(id) {
    const json = await getJson(`https://api.fxtwitter.com/i/status/${id}`);
    const all = json?.tweet?.media?.all ?? [];
    return all.map(fromEntity).filter(Boolean);
  }

  /**
   * @returns {Promise<{items: object[], source: string}>} media the caller should
   *   add. Video/gif first: the click was on a video, so a poster-turned-image
   *   should not win over the actual stream.
   */
  async function resolveTweet(input) {
    const id = idFromUrl(input);
    if (!id) throw new Error('no status id in input');
    const errors = [];
    for (const [source, fn] of [
      ['syndication', fromSyndication],
      ['fxtwitter', fromFx],
    ]) {
      try {
        const media = await fn(id);
        if (media.length === 0) {
          errors.push(`${source}: no media`);
          continue;
        }
        const motion = media.filter((m) => m.kind === 'video' || m.kind === 'gif');
        return { items: (motion.length > 0 ? motion : media).map((m) => ({ ...m, tweetId: id })), source };
      } catch (err) {
        errors.push(`${source}: ${err.message}`);
      }
    }
    throw new Error(`could not resolve ${id} (${errors.join(' | ')})`);
  }

  globalThis.XMPResolve = { resolveTweet, idFromUrl };
})();
