/**
 * Content script: Alt+click adds or removes a media entry.
 *
 * Hard-won constraints:
 *  - pick.core.js is injected as a preceding classic script. A runtime import()
 *    is subject to the host page's CSP and fails silently on x.com.
 *  - X navigates on pointerdown/pointerup, so the whole pointer sequence is
 *    cancelled while Alt is held, not just `click`.
 *  - The page sets `cursor: pointer` on its own images and links, so a
 *    `cursor: crosshair` on <html> never reaches them. Cursor and highlight are
 *    therefore applied straight to the hit element (attribute + !important),
 *    driven by pointermove instead of :hover — the hover target is often an
 *    overlay div, not the <img>.
 */
(function initPicker() {
  'use strict';
  if (window.__xmpPickerLoaded) return;
  window.__xmpPickerLoaded = true;

  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '?';
    }
  })();

  const pick = globalThis.XMPPick;
  if (!pick) {
    const bar = document.createElement('div');
    bar.textContent = 'X Media Picker: pick.core.js 未加载（扩展可能未重新加载）';
    bar.style.cssText =
      'position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:8px 12px;border-radius:8px;' +
      'background:#7f1d1d;color:#fff;font:12px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px #0008';
    (document.body || document.documentElement).appendChild(bar);
    console.error('[x-media-picker] globalThis.XMPPick missing — check content_scripts order in manifest.json');
    return;
  }

  const HIGHLIGHT_CSS = `
    html.__xmp-alt img,
    html.__xmp-alt video,
    html.__xmp-alt picture,
    html.__xmp-alt a:has(img),
    html.__xmp-alt a:has(video) { cursor: crosshair !important; }

    [data-xmp-hit] {
      outline: 3px solid #3b82f6 !important;
      outline-offset: -3px !important;
      cursor: crosshair !important;
    }
    [data-xmp-hit="post"] {
      outline: 2px dashed #22c55e !important;
      outline-offset: 3px !important;
    }
  `;
  const style = document.createElement('style');
  style.textContent = HIGHLIGHT_CSS;
  (document.head || document.documentElement).appendChild(style);

  // ---- Alt mode indicator -------------------------------------------------
  let badge = null;
  let count = 0;
  function showBadge(show) {
    if (!show) {
      if (badge) badge.style.display = 'none';
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:fixed;z-index:2147483647;right:14px;bottom:14px;pointer-events:none;' +
        'padding:6px 12px;border-radius:999px;background:#111827;border:1px solid #3b82f6;' +
        'color:#bfdbfe;font:600 12px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px #0007';
      document.documentElement.appendChild(badge);
    }
    badge.textContent = `ALT · ${count}`;
    badge.style.display = 'block';
  }

  function setAlt(on) {
    document.documentElement.classList.toggle('__xmp-alt', on);
    showBadge(on);
    if (on) refreshHit(lastPoint.x, lastPoint.y);
    else clearHit();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') setAlt(true);
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') setAlt(false); }, true);
  window.addEventListener('blur', () => setAlt(false), true);

  // ---- toast --------------------------------------------------------------
  let toastHost = null;
  let toastTimer = 0;
  let toastBox = null;
  function toast(title, detail = '', tone = 'ok') {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:56px;pointer-events:none';
      const root = toastHost.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .box{font:13px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;background:#111827;color:#e5e7eb;
               padding:10px 14px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);
               border:1px solid #374151;max-width:340px;opacity:0;transform:translateY(6px);
               transition:opacity .15s ease,transform .15s ease}
          .box.show{opacity:1;transform:translateY(0)}
          .t{font-weight:600;margin-bottom:2px}
          .ok{color:#93c5fd}.bad{color:#fca5a5}.warn{color:#fcd34d}
          .u{color:#9ca3af;word-break:break-all;font-size:11px}
        </style>
        <div class="box" id="box"><div class="t"></div><div class="u"></div></div>`;
      document.documentElement.appendChild(toastHost);
      toastBox = toastHost.shadowRoot.getElementById('box');
    }
    const toneClass = tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : 'ok';
    const t = toastBox.querySelector('.t');
    const u = toastBox.querySelector('.u');
    t.className = `t ${toneClass}`;
    t.textContent = title;
    u.textContent = detail;
    requestAnimationFrame(() => toastBox.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastBox.classList.remove('show'), 2400);
  }

  // ---- target resolution --------------------------------------------------
  const PLAYER = [
    '[data-testid="videoPlayer"]',
    '[data-testid="videoComponent"]',
    '[data-testid="previewInterstitial"]',
    '[data-testid="swipe-to-dismiss"]',
  ].join(',');

  /**
   * Which element did the user actually aim at?
   *
   * On X the clickable area of a video is an overlay <div> that is a *sibling*
   * of <video>, not a child — so `closest()` from the overlay finds nothing and
   * `querySelector()` on the overlay finds nothing either. Clicking the video
   * therefore did nothing while clicking elsewhere in the post worked, which is
   * exactly backwards. The search now climbs the tree up to (and including) the
   * post boundary, so the player is found from any part of its own area, while a
   * click on empty post space stays a no-op instead of silently grabbing the
   * author's avatar.
   */
  function resolveElement(node) {
    if (!node || node.nodeType !== 1) return null;

    // 1. straight hit: the node is media, or sits inside it
    const video = node.closest('video');
    if (video) return video;
    const still = node.closest('img, picture');
    if (still) return still;

    // 2. a known player container that owns the <video>
    const player = node.closest(PLAYER);
    if (player) {
      const inner = player.querySelector('video, picture, img');
      if (inner) return inner;
    }

    // 3. climb: overlay layers live next to the media they cover
    let cur = node;
    for (let depth = 0; cur && depth < 7; depth += 1) {
      const found = cur.querySelector?.('video');
      if (found) return found;
      if (cur.tagName === 'ARTICLE') break; // never reach into a neighbouring post
      cur = cur.parentElement;
    }

    // 4. a link whose target is the media file itself
    const anchor = node.closest('a[href]');
    if (anchor) {
      const inner = anchor.querySelector('video, picture, img');
      if (inner) return inner;
      const href = anchor.getAttribute('href') || '';
      if (pick.classifyUrl(href) === 'image' || pick.classifyUrl(href) === 'video') return anchor;
    }

    // 5. a block painted with a CSS background image
    if (cssBackground(node)) return node;

    return null;
  }

  /** `url(...)` of a computed background-image, if any. */
  function cssBackground(node) {
    try {
      return pick.backgroundUrl(getComputedStyle(node).backgroundImage);
    } catch {
      return null;
    }
  }

  /**
   * Page-level fallback, used only when the clicked element itself gives nothing
   * usable. These are the conventions every site already publishes for link
   * previews, so this stays site-agnostic instead of guessing per-site APIs.
   */
  function pageLevelMedia() {
    const meta = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute('content') || '' : '';
    };
    const video =
      meta('meta[property="og:video:secure_url"]') ||
      meta('meta[property="og:video:url"]') ||
      meta('meta[property="og:video"]') ||
      meta('meta[name="twitter:player:stream"]');
    if (video) return { kind: pick.classifyUrl(video) === 'hls' ? 'hls' : 'video', url: video };

    const image = meta('meta[property="og:image:secure_url"]') || meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
    if (image) return { kind: 'image', url: image };

    return null;
  }

  function postUrlNear(node) {
    const host = node?.closest?.('article, [data-testid="tweet"]') ?? node;
    const link = host?.querySelector?.('a[href*="/status/"]');
    if (link) {
      try {
        return new URL(link.getAttribute('href'), location.origin).toString();
      } catch {
        /* fall through to the address bar */
      }
    }
    // A fullscreen player sits outside the article; the post id is in the URL.
    const fromPath = /\/status\/(\d{5,25})/.exec(location.pathname || '');
    return fromPath ? `https://x.com/i/status/${fromPath[1]}` : null;
  }

  // ---- live highlight -----------------------------------------------------
  let hitEl = null;
  const lastPoint = { x: 0, y: 0 };

  function clearHit() {
    if (!hitEl) return;
    try {
      hitEl.removeAttribute('data-xmp-hit');
    } catch {
      /* element gone */
    }
    hitEl = null;
  }

  function refreshHit(x, y) {
    if (!document.documentElement.classList.contains('__xmp-alt')) return;
    let node = null;
    try {
      node = document.elementFromPoint(x, y);
    } catch {
      node = null;
    }
    // The topmost node is often a transparent overlay; walk up a few levels
    // looking for a container that actually holds the media.
    let element = null;
    for (let depth = 0; node && depth < 4 && !element; depth += 1) {
      element = resolveElement(node);
      node = node.parentElement ?? null;
    }
    if (!element) {
      clearHit();
      return;
    }
    if (element === hitEl) return;
    clearHit();
    element.setAttribute('data-xmp-hit', '');
    hitEl = element;
  }

  let lastMoveAt = 0;
  window.addEventListener(
    'pointermove',
    (event) => {
      lastPoint.x = event.clientX;
      lastPoint.y = event.clientY;
      if (!event.altKey) return;
      const now = Date.now();
      if (now - lastMoveAt < 40) return;
      lastMoveAt = now;
      refreshHit(event.clientX, event.clientY);
    },
    true,
  );
  window.addEventListener('scroll', () => { if (hitEl) refreshHit(lastPoint.x, lastPoint.y); }, true);

  // ---- toggle -------------------------------------------------------------
  let lastPointerDownAt = 0;

  function cancel(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  async function toggle(item) {
    try {
      if (item.kind === 'post') toast('正在解析帖子里的视频地址…', item.url, 'warn');
      const res = await chrome.runtime.sendMessage({ type: 'xmp:toggle', item });
      if (!res?.ok) {
        toast('加入失败', res?.error ?? '后台未响应', 'bad');
        return;
      }
      count = res.count;
      if (document.documentElement.classList.contains('__xmp-alt')) showBadge(true);

      const first = res.items?.[0];
      const detail = first?.url ?? item.url;

      if (res.resolved) {
        const label = pick.kindLabel(first?.kind ?? 'video');
        const dims = first?.width ? ` ${first.width}x${first.height}` : '';
        if (res.added > 0) toast(`已解析为${label}${dims}（+${res.added}，列表 ${res.count}）`, detail, 'ok');
        else toast(`已移出（${res.removed}，列表 ${res.count}）`, detail, 'warn');
        return;
      }

      if (item.kind === 'post') {
        toast('解析失败，已存为帖子链接', res.resolveError ?? detail, 'bad');
        return;
      }

      const label = pick.kindLabel(item.kind);
      if (res.action === 'added') toast(`已加入列表（${res.count}）：${label}`, detail, 'ok');
      else toast(`已移出列表（${res.count}）：${label}`, detail, 'warn');
    } catch (err) {
      toast('扩展上下文不可用', String(err?.message ?? err), 'bad');
    }
  }

  function handle(type, event) {
    if (!event.altKey || event.button !== 0) return;
    const element = resolveElement(event.target);
    if (!element) return;

    let described = pick.describeNode(element);
    if (!described) {
      const bg = cssBackground(element);
      if (bg) described = { kind: pick.classifyUrl(bg), url: bg };
    }
    if (!described || described.kind === 'ephemeral' || described.kind === 'cover' || described.kind === 'unknown') {
      const fallback = postUrlNear(element);
      if (fallback) {
        described = { kind: 'post', url: fallback, reason: described?.reason };
      } else {
        const page = pageLevelMedia();
        if (page) described = { ...page, reason: described?.reason };
      }
    }
    if (!described) return;

    cancel(event);

    if (type === 'pointerdown') {
      lastPointerDownAt = Date.now();
      toggle(described);
    } else if (type === 'click' && Date.now() - lastPointerDownAt > 250) {
      toggle(described);
    }
  }

  for (const type of ['pointerdown', 'pointerup', 'mouseup', 'click', 'auxclick']) {
    window.addEventListener(type, (event) => handle(type, event), true);
  }

  // ---- self report (popup asks) ------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'xmp:ping') return undefined;
    reply({
      ok: true,
      version: VERSION,
      alt: document.documentElement.classList.contains('__xmp-alt'),
      hits: document.querySelectorAll('[data-xmp-hit]').length,
    });
    return undefined;
  });
})();
