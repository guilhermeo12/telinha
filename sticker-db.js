// Telinha · veio do Crunchy Sync (stickers-db.js), só com o nome do banco trocado.
// Figurinhas: banco local do navegador (IndexedDB) da extensão.
//  - "collection": as suas figurinhas (importadas de .zip / arquivos ou salvas do chat);
//  - "cache": figurinhas recebidas de outras pessoas (para não baixar de novo), limitado.
// Cada figurinha é identificada pelo SHA-256 dos bytes: a mesma nunca duplica, e quem recebe
// confere que os bytes batem com o identificador (não dá para trocar a imagem no caminho).
globalThis.StickerDB = globalThis.StickerDB || (() => {
  const DB_NAME = 'telinha-stickers', VERSION = 1;
  const MAX_BYTES = 1024 * 1024;   // 1 MB por figurinha
  const MAX_CACHE = 150;           // figurinhas recebidas guardadas
  const THUMB = 96;                // miniatura para o painel
  const MIMES = ['image/webp', 'image/png', 'image/gif'];
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, VERSION);
        r.onupgradeneeded = () => {
          for (const name of ['collection', 'cache']) {
            if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath: 'id' }).createIndex('addedAt', 'addedAt');
          }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }

  // ---------- bytes ----------
  async function sha256(bytes) {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const isId = id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
  // confere o tipo pelo conteúdo (não pelo nome do arquivo)
  function sniff(bytes) {
    const b = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength));
    const s = String.fromCharCode(...b);
    if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'image/webp';
    if (b[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'image/png';
    if (s.startsWith('GIF87a') || s.startsWith('GIF89a')) return 'image/gif';
    return null;
  }
  function isAnimated(bytes, mime) {
    const b = new Uint8Array(bytes);
    const find = (str, from, to) => {
      outer: for (let i = from; i <= Math.min(b.length, to) - str.length; i++) {
        for (let j = 0; j < str.length; j++) if (b[i + j] !== str.charCodeAt(j)) continue outer;
        return true;
      }
      return false;
    };
    if (mime === 'image/webp') return find('ANIM', 12, 4096) || find('ANMF', 12, 4096);
    if (mime === 'image/gif') {
      let frames = 0;
      for (let i = 0; i < b.length - 2 && frames < 2; i++) if (b[i] === 0x21 && b[i + 1] === 0xF9 && b[i + 2] === 0x04) frames++;
      return frames >= 2;
    }
    return false;
  }
  function toB64(bytes) {
    const u8 = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  // miniatura PNG pequena (painel do player). Funciona em página e no service worker.
  async function makeThumb(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const png = await c.convertToBlob({ type: 'image/png' });
      const out = { thumb: toB64(await png.arrayBuffer()), w: bmp.width, h: bmp.height };
      bmp.close && bmp.close();
      return out;
    } catch { return { thumb: null, w: 0, h: 0 }; }
  }

  // Prepara um registro a partir dos bytes; null se não for figurinha válida.
  async function prepare(bytes, { source = 'arquivo', expectId = null, thumb = null, w = 0, h = 0 } = {}) {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
    const mime = sniff(bytes);
    if (!mime) return null;
    const id = await sha256(bytes);
    if (expectId && id !== expectId) return null; // bytes não batem com o identificador: adulterado
    const blob = new Blob([bytes], { type: mime });
    if (!thumb) { const t = await makeThumb(blob); thumb = t.thumb; w = w || t.w; h = h || t.h; }
    return { id, blob, mime, w, h, size: bytes.byteLength, animated: isAnimated(bytes, mime), thumb, source, addedAt: Date.now() };
  }

  // ---------- coleção / cache ----------
  const get = (store, id) => tx(store, 'readonly', s => s.get(id));
  async function getAny(id) { return (await get('collection', id)) || (await get('cache', id)) || null; }
  const list = async store => ((await tx(store, 'readonly', s => s.getAll())) || []).sort((a, b) => b.addedAt - a.addedAt);
  const count = store => tx(store, 'readonly', s => s.count());
  const remove = (store, id) => tx(store, 'readwrite', s => s.delete(id));

  async function addToCollection(rec) {
    if (!rec) return { added: false, invalid: true };
    if (await get('collection', rec.id)) return { id: rec.id, added: false };
    await tx('collection', 'readwrite', s => s.put(rec));
    return { id: rec.id, added: true };
  }
  async function putCache(rec) {
    if (!rec || (await get('collection', rec.id)) || (await get('cache', rec.id))) return;
    await tx('cache', 'readwrite', s => s.put(rec));
    const all = await list('cache');
    for (const old of all.slice(MAX_CACHE)) await remove('cache', old.id);
  }
  // salva na coleção uma figurinha recebida
  async function saveFromCache(id) {
    const rec = await get('cache', id);
    if (!rec) return { added: false };
    const r = await addToCollection({ ...rec, source: 'recebida', addedAt: Date.now() });
    await remove('cache', id);
    return r;
  }

  return { MAX_BYTES, MIMES, sha256, isId, sniff, isAnimated, toB64, fromB64, makeThumb, prepare,
           get, getAny, list, count, remove, addToCollection, putCache, saveFromCache };
})();
