import './pick.core.js';

const { kindLabel } = globalThis.XMPPick;

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const countEl = $('count');
const emptyEl = $('empty');
const statusEl = $('status');
const healthEl = $('health');

let items = [];

/**
 * Tells the user whether the content script is actually alive on this tab.
 * Without this, "Alt does nothing" is indistinguishable from "extension not
 * reloaded" — which is exactly how the first two versions failed silently.
 */
async function checkHealth() {
  const manifest = chrome.runtime.getManifest();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('no active tab');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'xmp:ping' });
    if (!res?.ok) throw new Error('no answer');
    healthEl.className = 'health ok';
    healthEl.textContent = `本页脚本已注入 · v${res.version}${res.version !== manifest.version ? `（扩展是 v${manifest.version}，请重新加载）` : ''}`;
  } catch {
    healthEl.className = 'health bad';
    healthEl.textContent = `本页未注入（扩展 v${manifest.version}）。整页刷新一次；刚重载过扩展的话，老标签页必须刷新。`;
  }
}

function setStatus(text) {
  statusEl.textContent = text ?? '';
  if (text) setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ''; }, 2600);
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'no response');
  return res;
}

function render() {
  countEl.textContent = String(items.length);
  emptyEl.classList.toggle('hidden', items.length > 0);
  listEl.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'item';

      const kind = document.createElement('span');
      kind.className = `kind${item.kind === 'post' ? ' post' : ''}`;
      kind.textContent = kindLabel(item.kind);

      const link = document.createElement('a');
      link.className = 'url';
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = item.url;
      link.title = item.reason ? `${item.url}\n(${item.reason})` : item.url;

      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '从列表移除';
      del.addEventListener('click', async () => {
        await send('xmp:remove', { url: item.url });
        await load();
      });

      li.append(kind, link, del);
      return li;
    }),
  );
}

async function load() {
  const res = await send('xmp:list');
  items = res.list ?? [];
  render();
}

$('clear').addEventListener('click', async () => {
  await send('xmp:clear');
  await load();
  setStatus('列表已清空');
});

$('download').addEventListener('click', async () => {
  if (items.length === 0) return setStatus('列表是空的');
  const res = await send('xmp:download');
  const pending = (res.skipped ?? []).length;
  setStatus(`已开始 ${res.started} 个下载${pending ? `，${pending} 个帖子链接需要交给 xmd 解析` : ''}`);
});

$('copy').addEventListener('click', async () => {
  if (items.length === 0) return setStatus('列表是空的');
  await navigator.clipboard.writeText(items.map((i) => i.url).join('\n'));
  setStatus(`已复制 ${items.length} 条链接`);
});

$('export').addEventListener('click', () => {
  if (items.length === 0) return setStatus('列表是空的');
  const lines = items.map((i) => i.url);
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `x-media-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  setStatus(`已导出 ${lines.length} 条`);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.list) {
    items = changes.list.newValue ?? [];
    render();
  }
});

load().catch((err) => setStatus(`读取失败：${err.message}`));
checkHealth();
