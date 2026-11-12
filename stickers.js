/* global $, host, watch, send, friendName, myName, myCode, toast, StickerDB, MiniZip */
/* Telinha · figurinhas no chat da sala (veio do Crunchy Sync). Você importa um .zip (o exportado das figurinhas
   do WhatsApp, por exemplo) ou imagens .webp/.png/.gif; animadas continuam animadas. Cada figurinha é
   identificada pelo SHA-256 dos bytes: quem transmite confere antes de repassar, e quem recebe confere de novo,
   então ninguém troca a imagem no caminho. Os bytes vão uma vez só para cada pessoa; depois só o identificador. */
'use strict';

const Stickers = (() => {
  const MIMES = StickerDB.MIMES;
  const MAX_B64 = Math.ceil(StickerDB.MAX_BYTES / 3) * 4 + 8;
  const MIN_INTERVAL = 1500; // uma figurinha a cada 1,5 s por pessoa
  const KEEP = 60; // figurinhas guardadas por quem transmite nesta sala (para quem entra depois)
  const isId = (id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
  const role = () => (host.stream ? 'host' : watch.code && watch.state === 'watching' ? 'viewer' : null);

  // quem transmite: bytes desta sala e quem já recebeu cada figurinha
  const payload = new Map(); // id -> { mime, data }
  const known = new Map(); // id -> Set(código)
  const sentToHost = new Set(); // quem assiste: figurinhas cujos bytes já foram para quem transmite
  const asked = new Set(); // quem assiste: figurinhas já pedidas para quem transmite
  const ready = new Map(); // id -> Promise do registro (chegando pela rede)

  // ---------------------------------------------------------------- imagens
  const urls = new Map(); // id -> blob: URL (uma por figurinha, reaproveitada)
  async function urlOf(id) {
    if (urls.has(id)) return urls.get(id);
    const rec = (await StickerDB.getAny(id)) || (await ready.get(id));
    if (!rec) return null;
    const u = URL.createObjectURL(rec.blob);
    urls.set(id, u);
    return u;
  }
  // Preenche um <img> do chat quando os bytes chegarem (o identificador pode chegar antes)
  const waiting = new Map(); // id -> Set(<img>) esperando os bytes
  async function fill(img, id) {
    const u = await urlOf(id);
    if (u) return void (img.src = u);
    if (!waiting.has(id)) waiting.set(id, new Set());
    waiting.get(id).add(img);
    // quem acabou de entrar recebe o histórico antes de o vídeo começar: pede já, sem esperar "assistindo"
    if (watch.code && !host.stream && !asked.has(id)) {
      asked.add(id);
      send(watch.code, { t: 'sticker-req', id });
    }
  }

  // Figurinha subindo por cima do vídeo (some sozinha)
  async function fly(layer, id, name) {
    const u = await urlOf(id);
    if (!u || !window.Room?.flyOn()) return;
    if (window.Present?.presenting()) {
      const rec = await StickerDB.getAny(id);
      if (rec) window.telinha.overlayFx?.({ kind: 'sticker', name, src: `data:${rec.mime};base64,${StickerDB.toB64(await rec.blob.arrayBuffer())}` });
    }
    const box = document.createElement('div');
    box.className = 'stickerFly';
    box.style.setProperty('--x', `${10 + Math.random() * 65}%`);
    const img = document.createElement('img');
    img.src = u;
    img.alt = '';
    const n = document.createElement('span');
    n.textContent = name;
    box.append(img, n);
    layer.append(box);
    setTimeout(() => box.remove(), 4300);
  }

  // ---------------------------------------------------------------- mandar
  const b64Of = async (rec) => StickerDB.toB64(await rec.blob.arrayBuffer());
  let lastSent = 0;
  async function sendSticker(id) {
    const r = role();
    if (!r) return toast('Entre numa transmissão para mandar figurinhas.', true);
    if (performance.now() - lastSent < MIN_INTERVAL) return toast('Calma: uma figurinha a cada 1,5 s.', true);
    lastSent = performance.now();
    const rec = await StickerDB.getAny(id);
    if (!rec) return;
    if (r === 'viewer') {
      const msg = { t: 'sticker', id, mime: rec.mime };
      if (!sentToHost.has(id)) { msg.data = await b64Of(rec); sentToHost.add(id); }
      send(watch.code, msg);
    } else {
      remember(id, rec.mime, await b64Of(rec));
      hostShare(myCode, id);
    }
    closePanel();
  }

  function remember(id, mime, data) {
    if (payload.has(id)) return;
    payload.set(id, { mime, data });
    while (payload.size > KEEP) {
      const old = payload.keys().next().value;
      payload.delete(old);
      known.delete(old);
    }
  }

  // Quem transmite: manda os bytes para quem ainda não tem e põe a figurinha no chat da sala
  function hostShare(from, id) {
    const p = payload.get(id);
    if (!known.has(id)) known.set(id, new Set());
    const k = known.get(id);
    if (from !== myCode) k.add(from);
    for (const code of host.viewers.keys()) {
      if (k.has(code)) continue;
      send(code, { t: 'sticker-data', id, mime: p.mime, data: p.data });
      k.add(code);
    }
    window.Room.hostPost({ from, name: from === myCode ? myName() : friendName(from), sticker: id, ts: Date.now() });
  }

  // Confere os bytes contra o identificador e guarda como "recebida"
  function receive(id, mime, data) {
    if (!isId(id) || !MIMES.includes(mime) || typeof data !== 'string' || data.length > MAX_B64) return null;
    if (!ready.has(id)) {
      ready.set(id, (async () => {
        if (await StickerDB.getAny(id)) return StickerDB.getAny(id);
        let bytes;
        try { bytes = StickerDB.fromB64(data); } catch { return null; }
        const rec = await StickerDB.prepare(bytes, { source: 'recebida', expectId: id });
        if (rec) await StickerDB.putCache(rec);
        else ready.delete(id); // bytes que não batem: os certos ainda podem chegar
        if (rec && waiting.has(id)) {
          const u = await urlOf(id);
          for (const img of waiting.get(id)) img.src = u;
          waiting.delete(id);
        }
        return rec;
      })());
    }
    return ready.get(id);
  }

  function onMessage(code, msg) {
    switch (msg.t) {
      case 'sticker': {
        // quem assiste mandou uma figurinha
        const v = host.viewers.get(code);
        if (!v || !isId(msg.id) || !MIMES.includes(msg.mime)) return;
        const now = performance.now();
        if (now - (v.lastSticker || -1e9) < MIN_INTERVAL) return;
        v.lastSticker = now;
        (async () => {
          if (!payload.has(msg.id)) {
            if (!(await receive(msg.id, msg.mime, msg.data))) {
              // sem os bytes (ou bytes que não batem): pede de novo
              v.lastSticker = 0;
              send(code, { t: 'sticker-need', id: msg.id });
              return;
            }
            remember(msg.id, msg.mime, msg.data);
          }
          hostShare(code, msg.id);
        })();
        return;
      }
      case 'sticker-need': {
        if (code !== watch.code || !isId(msg.id)) return;
        sentToHost.delete(msg.id);
        lastSent = 0;
        sendSticker(msg.id);
        return;
      }
      case 'sticker-req': {
        // quem entrou depois viu a figurinha no histórico do chat e não tem os bytes
        const p = isId(msg.id) && host.viewers.has(code) && payload.get(msg.id);
        if (p) {
          send(code, { t: 'sticker-data', id: msg.id, mime: p.mime, data: p.data });
          known.get(msg.id)?.add(code);
        }
        return;
      }
      case 'sticker-data':
        if (code === watch.code) receive(msg.id, msg.mime, msg.data);
        return;
      default:
    }
  }

  // ---------------------------------------------------------------- painel (um em cada chat)
  let tab = 'collection';
  let openPanel = null;
  function closePanel() {
    openPanel?.remove();
    openPanel = null;
  }
  async function renderPanel(panel) {
    const items = await StickerDB.list(tab);
    const grid = panel.querySelector('.stGrid');
    grid.replaceChildren(...items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stItem';
      b.title = tab === 'collection' ? `Mandar${it.animated ? ' (animada)' : ''}` : 'Guardar nas suas figurinhas';
      const img = document.createElement('img');
      img.alt = it.animated ? 'Figurinha animada' : 'Figurinha';
      img.src = it.thumb ? `data:image/png;base64,${it.thumb}` : URL.createObjectURL(it.blob);
      b.append(img);
      b.addEventListener('click', async () => {
        if (tab === 'collection') sendSticker(it.id);
        else {
          await StickerDB.saveFromCache(it.id);
          toast('Figurinha guardada nas suas.');
          renderPanel(panel);
        }
      });
      if (tab === 'collection') {
        const x = document.createElement('span');
        x.className = 'stDel';
        x.textContent = '✕';
        x.title = 'Apagar figurinha';
        x.addEventListener('click', async (e) => {
          e.stopPropagation();
          await StickerDB.remove('collection', it.id);
          renderPanel(panel);
        });
        b.append(x);
      }
      return b;
    }));
    panel.querySelector('.stEmpty').hidden = items.length > 0;
    for (const t of panel.querySelectorAll('[data-tab]')) t.classList.toggle('on', t.dataset.tab === tab);
  }

  function togglePanel(form) {
    if (openPanel?.parentElement === form.parentElement) return closePanel();
    closePanel();
    const panel = document.createElement('div');
    panel.className = 'stickerPanel';
    panel.innerHTML = `
      <div class="stTabs"><button type="button" data-tab="collection">Minhas</button><button type="button" data-tab="cache">Recebidas</button>
        <button type="button" class="stImport" title="Importar .zip ou imagens .webp/.png/.gif">Importar</button></div>
      <div class="stGrid"></div>
      <p class="stEmpty muted small">Nenhuma figurinha. Use Importar: um .zip (ex.: exportado das figurinhas do WhatsApp) ou imagens .webp, .png ou .gif de até 1 MB.</p>
      <input type="file" class="stFiles" accept=".zip,.webp,.png,.gif,image/webp,image/png,image/gif" multiple hidden>`;
    panel.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { tab = t.dataset.tab; renderPanel(panel); }
      if (e.target.closest('.stImport')) panel.querySelector('.stFiles').click();
    });
    panel.querySelector('.stFiles').addEventListener('change', async (e) => {
      const msg = await importFiles([...e.target.files]);
      e.target.value = '';
      toast(msg.text, msg.bad);
      tab = 'collection';
      renderPanel(panel);
    });
    form.before(panel);
    openPanel = panel;
    renderPanel(panel);
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  // Importar: .zip (sem compressão ou "deflate") e imagens soltas
  async function importFiles(files) {
    let added = 0, dup = 0, bad = 0;
    const entries = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.zip$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
        try { for (const z of await MiniZip.read(bytes)) entries.push(z.bytes); } catch { bad++; }
      } else entries.push(bytes);
    }
    for (const bytes of entries) {
      const rec = await StickerDB.prepare(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { source: 'importada' });
      if (!rec) { bad++; continue; }
      if ((await StickerDB.addToCollection(rec)).added) added++;
      else dup++;
    }
    return {
      text: `${added} figurinha(s) importada(s)${dup ? `, ${dup} já existiam` : ''}${bad ? `, ${bad} arquivo(s) ignorado(s) (não é .webp/.png/.gif ou passa de 1 MB)` : ''}.`,
      bad: !added && bad > 0,
    };
  }

  for (const form of [$('chatHostForm'), $('chatWatchForm')]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn stickerBtn';
    b.title = 'Figurinhas';
    b.setAttribute('aria-label', 'Figurinhas');
    b.textContent = '🖼️';
    b.addEventListener('click', () => togglePanel(form));
    form.querySelector('[type="submit"]').before(b);
  }

  // Saiu da sala ou parou de transmitir
  function reset() {
    payload.clear();
    known.clear();
    sentToHost.clear();
    asked.clear();
    waiting.clear();
    closePanel();
  }

  return { onMessage, fill, fly, reset, importFiles, sendSticker };
})();
window.Stickers = Stickers;
