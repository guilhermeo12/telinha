/* global $, host, watch, send, friendName, myName, myCode, toast, refreshUI, store, storeJson */
/* Telinha · a sala de uma transmissão: chat (com mensagens voando no vídeo), reações e "apontar na tela".
   Quem transmite é o centro da sala: quem assiste manda para ele, e ele repassa para todos que estão
   assistindo. Só quem está na sala pode falar, reagir ou apontar. */
'use strict';

const REACTIONS = ['🔥', '😂', '👏', '😮', '❤️', '👀'];
const MAX_CHAT = 50;
const isStickerId = (id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);

// Só emojis (até 3), inclusive bandeiras, tons de pele e combinações com ZWJ (veio do Crunchy Sync)
function cleanEmoji(s) {
  s = String(s || '').replace(/\s+/g, '');
  if (!s) return null;
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
  if (parts.length > 3) return null;
  const ok = parts.every((g) => /\p{Extended_Pictographic}/u.test(g) || /^\p{Regional_Indicator}{2}$/u.test(g) || /⃣/u.test(g));
  return ok ? parts.join('') : null;
}

const Room = (() => {
  const hostChat = [];
  const watchChat = [];
  let pointing = false;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const clock = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const inRoom = (code) => host.viewers.has(code);
  // Cor de quem aponta: estável a partir do código, clara o bastante para aparecer sobre qualquer tela
  function colorOf(code) {
    let x = 7;
    for (const ch of code) x = (x * 31 + ch.charCodeAt(0)) % 360;
    const h = x / 360, s = 0.9, l = 0.6;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // ---------------------------------------------------------------- chat
  function renderChat(list, items) {
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    list.replaceChildren(...(items.length ? items.map((m) => {
      const li = el('li', m.from === myCode ? 'chatMsg mine' : 'chatMsg');
      li.dataset.ts = m.ts; // o contador do chat minimizado (layout.js) conta pelas horas
      const head = el('div', 'chatHead');
      head.append(el('b', null, m.name), el('span', 'chatTime', clock(m.ts)));
      if (m.sticker) {
        const img = el('img', 'chatSticker');
        img.alt = 'Figurinha';
        window.Stickers?.fill(img, m.sticker);
        li.append(head, img);
      } else li.append(head, el('div', 'chatText', m.text));
      return li;
    }) : [el('li', 'emptyLine', 'Ninguém falou ainda.')]));
    if (atBottom || items.at(-1)?.from === myCode) {
      // Quem rola pode ser a lista ou o painel em volta (no Assistir a lista cresce com o painel): leva a última
      // mensagem para a vista nos dois casos, e de novo quando uma figurinha termina de carregar
      const last = list.lastElementChild;
      list.scrollTop = list.scrollHeight;
      last?.scrollIntoView({ block: 'nearest' });
      for (const img of last?.querySelectorAll('img') || []) img.addEventListener('load', () => last.scrollIntoView({ block: 'nearest' }), { once: true });
    }
  }
  const renderHostChat = () => renderChat($('chatHostList'), hostChat);
  const renderWatchChat = () => renderChat($('chatWatchList'), watchChat);

  // Mensagens e figurinhas voando por cima do vídeo: cada um liga ou desliga só para si
  const flyOn = () => store('telinha.flyChat') !== '0';
  for (const box of document.querySelectorAll('.chatFly')) {
    box.checked = flyOn();
    box.addEventListener('change', () => {
      store('telinha.flyChat', box.checked ? '1' : '0');
      for (const other of document.querySelectorAll('.chatFly')) other.checked = box.checked;
    });
  }
  // Atravessa o vídeo da direita para a esquerda, em faixas para não sobrepor
  const lanes = [];
  function flyChat(layer, name, text) {
    if (!flyOn()) return;
    const LANES = 6, now = performance.now();
    let lane = 0;
    for (let i = 0; i < LANES; i++) if ((lanes[i] || 0) < (lanes[lane] || 0)) lane = i;
    for (let i = 0; i < LANES; i++) if ((lanes[i] || 0) <= now) { lane = i; break; }
    const dur = Math.min(14, 8 + text.length / 40);
    lanes[lane] = now + dur * 450;
    const msg = el('div', 'chatFlyMsg');
    msg.style.top = `${6 + lane * 8}%`;
    msg.style.setProperty('--dur', `${dur}s`);
    msg.append(el('b', null, name), document.createTextNode(text));
    layer.append(msg);
    setTimeout(() => msg.remove(), dur * 1000 + 200);
  }
  function showLive(layer, m) {
    if (m.sticker) window.Stickers?.fly(layer, m.sticker, m.name);
    else {
      flyChat(layer, m.name, m.text);
      // quem apresenta vê também na tela de verdade (a janela por cima, fora da captura)
      if (flyOn() && window.Present?.presenting()) window.telinha.overlayFx?.({ kind: 'chat', name: m.name, text: m.text });
    }
  }

  function hostPost(entry) {
    hostChat.push(entry);
    if (hostChat.length > MAX_CHAT) hostChat.shift();
    for (const code of host.viewers.keys()) send(code, { t: 'chat-msg', ...entry });
    renderHostChat();
    showLive($('reactHost'), entry);
  }

  $('chatHostForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = clean($('chatHostInput').value);
    if (!text) return;
    if (!host.stream) {
      toast('O chat da sala abre quando você começa a transmitir.');
      return;
    }
    $('chatHostInput').value = '';
    hostPost({ from: myCode, name: myName(), text, ts: Date.now() });
  });
  $('chatWatchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = clean($('chatWatchInput').value);
    if (!text) return;
    if (watch.state !== 'watching') {
      toast('Entre numa transmissão para conversar com a sala.');
      return;
    }
    $('chatWatchInput').value = '';
    send(watch.code, { t: 'chat', text });
  });

  // ---------------------------------------------------------------- reações
  function floatReaction(layer, r, name) {
    if (window.Present?.presenting()) window.telinha.overlayFx?.({ kind: 'react', emoji: r, name });
    const span = el('span', 'reaction');
    span.append(el('span', 'rEmoji', r), el('span', 'rName', name));
    span.style.setProperty('--x', `${8 + Math.random() * 72}%`);
    layer.append(span);
    setTimeout(() => span.remove(), 2700);
  }
  const react = (r) => { if (watch.state === 'watching') send(watch.code, { t: 'react', r }); };
  for (const r of REACTIONS) {
    const b = el('button', 'reactBtn', r);
    b.type = 'button';
    b.title = 'Mandar reação para a sala';
    b.addEventListener('click', () => react(r));
    $('reactBar').append(b);
  }
  // Qualquer emoji: o "+" abre um campo (no Windows, Win + . abre o teclado de emojis); os últimos 4 ficam na barra
  let recent = (storeJson('telinha.emojis') || []).map(cleanEmoji).filter(Boolean).slice(0, 4);
  const recentBox = el('span', 'reactRecent');
  const plus = el('button', 'reactBtn reactPlus', '+');
  plus.type = 'button';
  plus.title = 'Qualquer emoji';
  plus.setAttribute('aria-label', 'Mandar qualquer emoji');
  const pickForm = el('form', 'emojiPick hidden');
  const pickInput = el('input');
  pickInput.placeholder = 'Emoji (Win + .)';
  pickInput.maxLength = 32;
  pickInput.setAttribute('aria-label', 'Emoji para mandar');
  pickForm.append(pickInput);
  function renderRecent() {
    recentBox.replaceChildren(...recent.map((r) => {
      const b = el('button', 'reactBtn', r);
      b.type = 'button';
      b.title = 'Mandar reação para a sala';
      b.addEventListener('click', () => react(r));
      return b;
    }));
  }
  plus.addEventListener('click', () => {
    pickForm.classList.toggle('hidden');
    if (!pickForm.classList.contains('hidden')) pickInput.focus();
  });
  pickForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const r = cleanEmoji(pickInput.value);
    if (!r) return toast('Só emojis (até 3).', true);
    react(r);
    if (!REACTIONS.includes(r)) {
      recent = [r, ...recent.filter((x) => x !== r)].slice(0, 4);
      storeJson('telinha.emojis', recent);
      renderRecent();
    }
    pickInput.value = '';
    pickForm.classList.add('hidden');
  });
  pickInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') pickForm.classList.add('hidden'); });
  renderRecent();
  $('reactBar').append(recentBox, plus, pickForm);

  // ---------------------------------------------------------------- apontar na tela
  // Coordenadas normalizadas sobre o quadro do vídeo (sem as faixas pretas do object-fit: contain)
  function videoPoint(video, e) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const scale = Math.min(r.width / vw, r.height / vh);
    const cw = vw * scale, ch = vh * scale;
    const x = (e.clientX - r.left - (r.width - cw) / 2) / cw;
    const y = (e.clientY - r.top - (r.height - ch) / 2) / ch;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [+x.toFixed(4), +y.toFixed(4)];
  }

  // Marca local (no próprio vídeo), para quem aponta ver na hora, sem esperar a volta pelo vídeo
  function localMark(layer, video, m) {
    const r = video.getBoundingClientRect(), lr = layer.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const scale = Math.min(r.width / vw, r.height / vh);
    const cw = vw * scale, ch = vh * scale;
    const ox = r.left - lr.left + (r.width - cw) / 2, oy = r.top - lr.top + (r.height - ch) / 2;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'markSvg');
    if (m.kind === 'point') {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', ox + m.x * cw);
      c.setAttribute('cy', oy + m.y * ch);
      c.setAttribute('r', 10);
      c.setAttribute('class', 'markDot');
      c.style.setProperty('--c', m.color);
      svg.append(c);
    } else {
      const p = document.createElementNS(NS, 'polyline');
      p.setAttribute('points', m.pts.map(([x, y]) => `${(ox + x * cw).toFixed(1)},${(oy + y * ch).toFixed(1)}`).join(' '));
      p.setAttribute('class', 'markLine');
      p.style.setProperty('--c', m.color);
      svg.append(p);
    }
    layer.append(svg);
    setTimeout(() => svg.remove(), m.kind === 'point' ? 2200 : 4000);
  }

  const video = $('remote');
  let stroke = null;
  video.addEventListener('pointerdown', (e) => {
    if (!pointing || watch.state !== 'watching' || e.button !== 0) return;
    const p = videoPoint(video, e);
    if (!p) return;
    e.preventDefault();
    stroke = { pts: [p], startX: e.clientX, startY: e.clientY, moved: false };
    video.setPointerCapture?.(e.pointerId);
  });
  video.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = videoPoint(video, e);
    if (!p) return;
    if (Math.hypot(e.clientX - stroke.startX, e.clientY - stroke.startY) > 8) stroke.moved = true;
    const last = stroke.pts.at(-1);
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004 && stroke.pts.length < 300) stroke.pts.push(p);
  });
  const endStroke = () => {
    if (!stroke) return;
    const s = stroke;
    stroke = null;
    const m = s.moved && s.pts.length > 1
      ? { kind: 'draw', pts: s.pts }
      : { kind: 'point', x: s.pts[0][0], y: s.pts[0][1] };
    send(watch.code, { t: 'point', ...m });
    localMark($('pointWatch'), video, { ...m, color: colorOf(myCode) });
  };
  video.addEventListener('pointerup', endStroke);
  video.addEventListener('pointercancel', () => { stroke = null; });

  function setPointing(on) {
    pointing = on && watch.state === 'watching';
    if (pointing && window.Draw?.mode) window.Draw.setMode(false);
    $('watchWrap').classList.toggle('pointing', pointing);
    $('pointBtn').textContent = pointing ? 'Parar de apontar' : 'Apontar na tela';
    $('pointBtn').classList.toggle('primary', pointing);
  }
  $('pointBtn').addEventListener('click', () => {
    if (watch.state !== 'watching') {
      toast('Entre numa transmissão para apontar na tela de quem está transmitindo.');
      return;
    }
    setPointing(!pointing);
    if (pointing) toast('Clique no vídeo para apontar, ou arraste para desenhar. Quem transmite vê na tela dele.');
  });

  // Marca vinda da rede: no máximo 300 pontos, coordenadas entre 0 e 1
  function cleanMark(m) {
    const n = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    if (m?.kind === 'draw') return { kind: 'draw', pts: (Array.isArray(m.pts) ? m.pts : []).slice(0, 300).map((p) => [n(p?.[0]), n(p?.[1])]) };
    return { kind: 'point', x: n(m?.x), y: n(m?.y) };
  }

  function hostShowMark(code, m) {
    const mark = { ...m, name: friendName(code), color: colorOf(code) };
    localMark($('pointHost'), $('preview'), mark);
    if (!window.Present?.presenting()) return; // outra pessoa apresenta: a marca vai na tela dela, não na de quem abriu a sala
    window.telinha.overlayMark?.(mark).then((shown) => {
      // Fonte "janela": não há como desenhar por cima só dela; avisa uma vez
      if (!shown && !hostShowMark.warned) {
        hostShowMark.warned = true;
        toast(`${mark.name} apontou na tela. Para a marca aparecer no seu monitor, transmita a tela inteira.`);
      }
    });
  }

  // ---------------------------------------------------------------- mensagens
  function onMessage(code, msg) {
    switch (msg.t) {
      case 'chat': {
        if (!inRoom(code)) return;
        // No máximo 3 mensagens a cada 2 s por pessoa: quem transmite repassa cada uma para a sala inteira
        const v = host.viewers.get(code);
        const now = Date.now();
        v.chatTimes = (v.chatTimes || []).filter((t) => now - t < 2000);
        if (v.chatTimes.length >= 3) return;
        v.chatTimes.push(now);
        const text = clean(msg.text);
        if (text) hostPost({ from: code, name: friendName(code), text, ts: Date.now() });
        return;
      }
      case 'chat-msg':
      case 'chat-history': {
        if (watch.code !== code) return;
        const items = (msg.t === 'chat-history' ? msg.items : [msg]) || [];
        for (const m of items.slice(-MAX_CHAT)) {
          const base = { from: String(m.from || ''), name: clean(m.name).slice(0, 24) || '?', ts: Number(m.ts) || Date.now() };
          const text = clean(m.text);
          const entry = isStickerId(m.sticker) ? { ...base, sticker: m.sticker } : text ? { ...base, text } : null;
          if (!entry) continue;
          watchChat.push(entry);
          if (msg.t === 'chat-msg') showLive($('reactWatch'), entry);
        }
        while (watchChat.length > MAX_CHAT) watchChat.shift();
        renderWatchChat();
        return;
      }
      case 'react': {
        const r = cleanEmoji(msg.r);
        if (!inRoom(code) || !r) return;
        const now = Date.now();
        // No máximo 4 reações por segundo por pessoa
        const v = host.viewers.get(code);
        v.reactTimes = (v.reactTimes || []).filter((t) => now - t < 1000);
        if (v.reactTimes.length >= 4) return;
        v.reactTimes.push(now);
        const ev = { t: 'react-ev', r, name: friendName(code) };
        for (const c of host.viewers.keys()) send(c, ev);
        floatReaction($('reactHost'), r, ev.name);
        return;
      }
      case 'react-ev':
        if (watch.code === code && cleanEmoji(msg.r)) floatReaction($('reactWatch'), cleanEmoji(msg.r), clean(msg.name).slice(0, 24));
        return;
      case 'point': {
        if (!inRoom(code) || !$('allowPoint').checked) return;
        const v = host.viewers.get(code);
        const now = Date.now();
        if (now - (v.lastPoint || 0) < 250) return; // um por quarto de segundo, no máximo
        v.lastPoint = now;
        const m = cleanMark(msg);
        hostShowMark(code, m);
        // A janela por cima da tela de quem transmite fica fora da captura: cada um desenha a marca no próprio vídeo
        const ev = { t: 'point-ev', ...m, name: friendName(code), color: colorOf(code) };
        for (const c of host.viewers.keys()) if (c !== code) send(c, ev);
        return;
      }
      case 'point-ev': {
        if (watch.code !== code || watch.state !== 'watching') return;
        const mark = { ...cleanMark(msg), name: clean(msg.name).slice(0, 24), color: /^#[0-9a-f]{6}$/i.test(msg.color || '') ? msg.color : '#ffd60a' };
        localMark($('pointWatch'), $('remote'), mark);
        if (window.Present?.presenting()) window.telinha.overlayMark?.(mark);
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- ciclo de vida (chamado por app.js)
  function onViewerJoin(code) {
    if (hostChat.length) send(code, { t: 'chat-history', items: hostChat });
  }
  function onHostStop() {
    window.Stickers?.reset();
    hostChat.length = 0;
    renderHostChat();
    window.telinha.overlayHide?.();
  }
  function onLeave() {
    window.Stickers?.reset();
    watchChat.length = 0;
    renderWatchChat();
    setPointing(false);
  }

  renderHostChat();
  renderWatchChat();
  return { onMessage, onViewerJoin, onHostStop, onLeave, setPointing, colorOf, hostPost, flyOn, cleanEmoji, REACTIONS };
})();

// app.js chama window.Room (um const global não vira propriedade de window)
window.Room = Room;
