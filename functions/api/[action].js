// Cloudflare Pages Function: /api/search, /api/chart, /api/artist, /api/stream
// Токен берется из переменной окружения YAM_TOKEN.

const API = 'https://api.music.yandex.net';
const SALT = 'XGRlBW9FXlekgbPrRHuSiA';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });

const img = (uri, size = '400x400') =>
  uri ? 'https://' + uri.replace('%%', size) : '';

const slim = (t) => ({
  id: t.id,
  title: t.title,
  artists: (t.artists || []).map((a) => ({ id: a.id, name: a.name })),
  duration: t.durationMs || 0,
  cover: img(t.albums?.[0]?.coverUri),
});

export async function onRequestGet({ params, request, env }) {
  if (!env.YAM_TOKEN) return json({ error: 'Не задан YAM_TOKEN в настройках Pages' }, 500);

  const headers = {
    Authorization: `OAuth ${env.YAM_TOKEN}`,
    'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
    'User-Agent': 'Yandex-Music-API',
  };
  const sp = new URL(request.url).searchParams;
  const get = async (path) => (await fetch(API + path, { headers, signal: AbortSignal.timeout(12000) })).json();

  try {
    // ---- Поиск треков ----
    if (params.action === 'search') {
      const q = sp.get('q') || '';
      const d = await get(`/search?type=track&page=0&nocorrect=false&text=${encodeURIComponent(q)}`);
      return json({ tracks: (d.result?.tracks?.results || []).map(slim) });
    }

    // ---- Топ-чарт (option: russia | world) ----
    if (params.action === 'chart') {
      const opt = sp.get('option') || 'russia';
      const d = await get(`/landing3/chart/${encodeURIComponent(opt)}`);
      const items = d.result?.chart?.tracks || [];
      return json({ tracks: items.map((x) => slim(x.track || x)) });
    }

    // ---- Страница исполнителя: популярные треки + все треки ----
    if (params.action === 'artist') {
      const id = sp.get('id');
      if (!id) return json({ error: 'Нужен id' }, 400);
      const aid = encodeURIComponent(id);
      const [info, all] = await Promise.all([
        get(`/artists/${aid}/brief-info`),
        get(`/artists/${aid}/tracks?page=0&page-size=100`).catch(() => ({})),
      ]);
      const r = info.result || {};
      const a = r.artist || {};
      const rest = (all.result?.tracks || []).map((x) => x.track || x);
      const seen = new Set();
      const tracks = [...(r.popularTracks || []), ...rest]
        .filter((t) => t && t.id && !seen.has(t.id) && seen.add(t.id))
        .map(slim);
      return json({
        artist: { id: a.id, name: a.name, cover: img(a.cover?.uri) },
        tracks,
      });
    }

    // ---- Текст песни: синхронизированный LRC, если есть, иначе обычный текст ----
    if (params.action === 'lyrics') {
      const id = sp.get('id');
      if (!id) return json({ error: 'Нужен id' }, 400);
      try {
        const r = await fetch(`${API}/tracks/${encodeURIComponent(id)}/lyrics`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ format: 'LRC', timeStamp: String(Date.now()) }),
          signal: AbortSignal.timeout(12000),
        });
        const d = await r.json();
        const link = d.result?.downloadUrl;
        if (link) {
          const lrc = await (await fetch(link, { signal: AbortSignal.timeout(12000) })).text();
          if (lrc.trim()) return json({ lrc });
        }
      } catch (_) { /* переходим к обычному тексту */ }
      const s = await get(`/tracks/${encodeURIComponent(id)}/supplement`);
      const text = s.result?.lyrics?.fullLyrics || s.result?.lyrics?.text || '';
      return json({ text });
    }

    // ---- Прямая ссылка на mp3 ----
    if (params.action === 'stream') {
      const id = sp.get('id');
      if (!id) return json({ error: 'Нужен id' }, 400);

      const d = await get(`/tracks/${id}/download-info`);
      const best = (d.result || []).sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0];
      if (!best) return json({ error: 'Нет доступных файлов' }, 404);

      const xml = await (await fetch(best.downloadInfoUrl)).text();
      const pick = (tag) => xml.match(new RegExp(`<${tag}>(.+?)</${tag}>`))?.[1];
      const host = pick('host');
      const path = pick('path');
      const s = pick('s');
      const ts = pick('ts');

      const sign = md5(SALT + path.slice(1) + s);
      return json({ url: `https://${host}/get-mp3/${sign}/${ts}${path}` });
    }

    return json({ error: 'Не найдено' }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

// Компактный MD5 (в Web Crypto его нет)
function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const n = bytes.length;
  const blocks = ((n + 8) >> 6) + 1;
  const words = new Uint32Array(blocks * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[blocks * 16 - 2] = n * 8;

  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < words.length; off += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + words[off + g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = (v) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((v >>> (i * 8)) & 255).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
