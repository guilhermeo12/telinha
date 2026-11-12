/* global $, host, watch, send, friendName, myName, myCode, toast, store, storeJson, DrawEngine */
/* Telinha · desenhar na tela. Todo mundo da sala (quem transmite e quem assiste) desenha por cima do vídeo com
   pincel, lápis, marca-texto, borracha, balde, linha, seta, retângulo e elipse. O motor (draw-engine.js) veio
   do Crunchy Sync. Quem transmite é o centro: recebe os traços de cada um, confere e repassa para os outros, e
   guarda o desenho para quem entra depois. Cada pessoa desenha o resultado por cima do próprio vídeo (nítido,
   sem o atraso da transmissão); quem transmite também vê na tela de verdade, numa janela que fica fora da
   captura (senão o desenho apareceria duas vezes para quem assiste). */
'use strict';

const Draw = (() => {
  const { DRAW } = DrawEngine;
  const COLORS = ['#ffffff', '#000000', '#8e8e93', '#ff3b30', '#ff9f0a', '#ffd60a', '#30d158',
    '#64d2ff', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#a2845e'];
  // tamanho e opacidade padrão de cada ferramenta (cada uma lembra os seus)
  const DEFAULTS = { pen: [6, 100], pencil: [5, 100], marker: [8, 40], eraser: [10, 100], fill: [6, 100],
    line: [4, 100], arrow: [4, 100], rect: [4, 100], ellipse: [4, 100] };
  const TOOLS = [
    ['pen', '🖌️', 'Pincel: sente a pressão da caneta; no mouse, afina quando você vai rápido'],
    ['pencil', '✏️', 'Lápis: traço fino'],
    ['marker', '🖍️', 'Marca-texto: largo e transparente'],
    ['eraser', '🧽', 'Borracha'],
    ['fill', '🪣', 'Balde de tinta: pinta a área fechada'],
    ['line', '╱', 'Linha (Shift trava o ângulo)'],
    ['arrow', '➚', 'Seta (Shift trava o ângulo)'],
    ['rect', '▭', 'Retângulo (Shift = quadrado)'],
    ['ellipse', '◯', 'Elipse (Shift = círculo)'],
  ];
  const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const role = () => (host.stream ? 'host' : watch.code && watch.state === 'watching' ? 'viewer' : null);

  // ---------------------------------------------------------------- preferências
  const prefs = { tool: 'pen', color: '#ff3b30', recent: [], fillShapes: false, tools: {} };
  const toolPref = (t) => prefs.tools[t] || (prefs.tools[t] = { size: DEFAULTS[t][0], opacity: DEFAULTS[t][1] });
  (() => {
    const p = storeJson('telinha.drawPrefs');
    if (!p || typeof p !== 'object') return;
    if (DEFAULTS[p.tool]) prefs.tool = p.tool;
    if (isHex(p.color)) prefs.color = p.color.toLowerCase();
    if (Array.isArray(p.recent)) prefs.recent = p.recent.filter(isHex).slice(0, 8);
    prefs.fillShapes = !!p.fillShapes;
    for (const t of Object.keys(DEFAULTS)) {
      const v = p.tools?.[t];
      if (v) prefs.tools[t] = { size: Math.min(60, Math.max(1, Number(v.size) || DEFAULTS[t][0])), opacity: Math.min(100, Math.max(5, Number(v.opacity) || DEFAULTS[t][1])) };
    }
  })();
  let saveTimer = null;
  const savePrefs = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => storeJson('telinha.drawPrefs', prefs), 600); };

  // ---------------------------------------------------------------- motor e camada
  const engine = DrawEngine.create({
    send: (data) => outgoing(data),
    raf: (fn) => requestAnimationFrame(fn),
    makeCanvas: () => document.createElement('canvas'),
    now: () => performance.now(),
  });
  const layer = document.createElement('div');
  layer.className = 'drawLayer';
  const base = document.createElement('canvas');
  const live = document.createElement('canvas');
  layer.append(base, live);
  engine.setCanvases(base, live);
  setInterval(() => engine.tick(), 5000);

  let mode = false;
  const video = () => (role() === 'host' ? $('preview') : $('remote'));
  const wrap = () => video().closest('.videoWrap');

  // A camada cobre só a imagem do vídeo (sem as faixas pretas do object-fit: contain)
  function place() {
    const r = role();
    if (!r || (!mode && !engine.count)) {
      if (layer.isConnected) layer.remove();
      engine.resize(0, 0);
      return;
    }
    const v = video(), w = wrap();
    if (layer.parentElement !== w) w.append(layer);
    const vr = v.getBoundingClientRect(), wr = w.getBoundingClientRect();
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const k = Math.min(vr.width / vw, vr.height / vh);
    const cw = vw * k, ch = vh * k;
    Object.assign(layer.style, {
      left: `${vr.left - wr.left + (vr.width - cw) / 2}px`, top: `${vr.top - wr.top + (vr.height - ch) / 2}px`,
      width: `${cw}px`, height: `${ch}px`,
    });
    const dpr = Math.min(2, devicePixelRatio || 1);
    engine.resize(cw * dpr, ch * dpr);
  }
  new ResizeObserver(() => place()).observe(document.body);
  for (const v of [$('preview'), $('remote')]) v.addEventListener('resize', place);
  setInterval(place, 1000); // troca de aba, tela cheia, painéis recolhendo

  // ---------------------------------------------------------------- sala
  // Quem assiste manda para quem transmite; quem transmite repassa para todos (com quem desenhou) e para a
  // janela por cima da sua tela
  function outgoing(data) {
    const { type, ...m } = data;
    void type;
    if (role() === 'viewer') {
      send(watch.code, { ...m, t: 'draw' });
      toOverlay({ ...m, by: myCode, name: myName() });
    }
    else if (role() === 'host') relay({ ...m, by: myCode, name: myName() }, null);
  }
  function relay(m, except) {
    for (const code of host.viewers.keys()) if (code !== except) send(code, { ...m, t: 'draw' });
    toOverlay(m);
  }

  // Tudo o que está na tela, em pedaços (quem entra depois, ou a janela por cima da tela)
  function snapshotChunks() {
    const st = engine.state;
    const out = [];
    let chunk = [], size = 0;
    for (const s of [...st.strokes, ...st.live.values()]) {
      const w = { by: s.by === 'me' ? myCode : s.by, name: s.by === 'me' ? myName() : s.name, sid: s.sid, tool: s.tool, color: s.color, size: s.size, opacity: s.opacity, done: s.done };
      if (s.pts) w.pts = s.pts;
      if (s.a) { w.a = s.a; w.fill = s.fill; }
      if (s.tool === 'fill') { w.x = s.x; w.y = s.y; }
      chunk.push(w);
      size += s.pts ? s.pts.length : 8;
      if (size > 30000) { out.push(chunk); chunk = []; size = 0; }
    }
    if (chunk.length) out.push(chunk);
    return out;
  }

  // Janela por cima da tela de quem transmite: na primeira mensagem ela nasce vazia e recebe o que já existe
  async function toOverlay(m) {
    if (m.op !== 'reset' && !window.Present?.presenting()) return;
    const fresh = await window.telinha.overlayDraw?.(m);
    if (fresh) for (const strokes of snapshotChunks()) window.telinha.overlayDraw?.({ op: 'snap', you: myCode, strokes });
  }

  // O que vai para a sala é só o que o desenho usa, já limitado (o resto da mensagem fica com quem mandou)
  function cleanWire(msg) {
    const sid = String(msg.sid || '');
    if (msg.op !== 'clear' && !/^[a-z0-9]{1,16}$/.test(sid)) return null;
    switch (msg.op) {
      case 'begin':
      case 'add': {
        const s = DrawEngine.cleanStroke(msg);
        return s && { op: msg.op, ...s };
      }
      case 'pts': {
        const pts = DrawEngine.cleanPts(msg.pts, DRAW.MAX_PTS_MSG * 3);
        return pts.length ? { op: 'pts', sid, pts } : null;
      }
      case 'end':
      case 'undo':
        return { op: msg.op, sid };
      case 'clear':
        return { op: 'clear', scope: msg.scope === 'all' ? 'all' : 'mine' };
      default:
        return null;
    }
  }

  const buckets = new Map(); // código -> { tokens, at }: no máximo RATE mensagens/s por pessoa, pico de BURST
  function allowed(code) {
    const now = performance.now();
    const b = buckets.get(code) || { tokens: DRAW.BURST, at: now };
    b.tokens = Math.min(DRAW.BURST, b.tokens + ((now - b.at) / 1000) * DRAW.RATE);
    b.at = now;
    buckets.set(code, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  function onMessage(code, msg) {
    if (msg.t === 'draw') {
      if (role() === 'host') {
        if (!host.viewers.has(code) || !allowed(code)) return;
        const clean = cleanWire(msg);
        if (!clean) return;
        const m = { ...clean, by: code, name: friendName(code) };
        apply(m);
        relay(m, code);
      } else if (code === watch.code) {
        const m = { ...msg };
        delete m.t;
        apply(m);
        toOverlay(m);
      }
    } else if (msg.t === 'draw-snap' && code === watch.code) {
      engine.snapshot({ you: myCode, strokes: Array.isArray(msg.strokes) ? msg.strokes.slice(0, DRAW.MAX_STROKES) : [] });
      place();
      renderPanel();
    }
  }
  function apply(m) {
    engine.remote(m);
    if (m.op === 'clear' && m.scope === 'all') toast(`${String(m.name || 'Alguém').slice(0, 24)} apagou os desenhos.`);
    place();
    if (m.op === 'clear' || m.op === 'undo') renderPanel();
  }

  // ---------------------------------------------------------------- painel
  const panel = document.createElement('div');
  panel.className = 'drawPanel';
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', 'Desenho');
  panel.innerHTML = `
    <div class="dpHead"><b>Desenhar</b><button type="button" class="dpX" title="Sair do modo desenho (Esc)" aria-label="Sair do modo desenho">✕</button></div>
    <div class="dpTools"></div>
    <div class="dpColors"></div>
    <div class="dpRecent"></div>
    <label class="dpRange">Tamanho <input type="range" class="dpSize" min="1" max="60"><b class="dpSizeV"></b></label>
    <label class="dpRange">Opacidade <input type="range" class="dpOp" min="5" max="100"><b class="dpOpV"></b></label>
    <label class="check dpCheck"><input type="checkbox" class="dpFill"> Formas preenchidas</label>
    <div class="dpActs">
      <button type="button" data-act="undo" title="Desfazer (Ctrl+Z)">↶</button>
      <button type="button" data-act="redo" title="Refazer (Ctrl+Y)">↷</button>
      <button type="button" data-act="mine" title="Apagar só os seus desenhos">Os meus</button>
      <button type="button" data-act="all" class="dpAll" title="Apagar os desenhos de todo mundo">Tudo</button>
    </div>
    <label class="check dpCheck"><input type="checkbox" class="dpShow" checked> Ver desenhos dos outros</label>
    <p class="dpHint">Esc sai · Ctrl+Z desfaz · [ ] tamanho</p>`;
  const q = (s) => panel.querySelector(s);
  for (const [tool, icon, title] of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tool = tool;
    b.textContent = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    q('.dpTools').append(b);
  }
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dpSw';
    b.dataset.c = c;
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', `Cor ${c}`);
    q('.dpColors').append(b);
  }
  const pick = document.createElement('label');
  pick.className = 'dpSw dpPick';
  pick.title = 'Qualquer cor';
  const pickInput = document.createElement('input');
  pickInput.type = 'color';
  pickInput.setAttribute('aria-label', 'Escolher qualquer cor');
  pick.append(pickInput);
  q('.dpColors').append(pick);

  function applyPrefs() {
    const tp = toolPref(prefs.tool);
    engine.set({ tool: prefs.tool, color: prefs.color, size: tp.size, opacity: tp.opacity / 100, fillShapes: prefs.fillShapes });
    renderPanel();
  }
  function setColor(c, remember) {
    if (!isHex(c)) return;
    prefs.color = c.toLowerCase();
    if (remember && !COLORS.includes(prefs.color)) prefs.recent = [prefs.color, ...prefs.recent.filter((x) => x !== prefs.color)].slice(0, 8);
    if (prefs.tool === 'eraser') prefs.tool = 'pen'; // escolheu cor = quer pintar
    applyPrefs();
    savePrefs();
  }
  function setSize(v) {
    toolPref(prefs.tool).size = Math.min(60, Math.max(1, Math.round(v)));
    applyPrefs();
    savePrefs();
  }
  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer);
    q('.dpAll').classList.remove('armed');
    q('.dpAll').textContent = 'Tudo';
  }
  function action(act) {
    if (act === 'undo') engine.undo();
    else if (act === 'redo') engine.redo();
    else if (act === 'mine') engine.clearMine();
    else if (act === 'all') {
      // "Tudo" apaga de todo mundo: pede um segundo clique para confirmar
      const b = q('.dpAll');
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Certeza?';
        armTimer = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      engine.clearAll();
      toast('Desenhos apagados para todos.');
    }
    renderPanel();
    place();
  }

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) { prefs.tool = b.dataset.tool; applyPrefs(); savePrefs(); }
    else if (b.dataset.c) setColor(b.dataset.c, false);
    else if (b.dataset.act) action(b.dataset.act);
    else if (b.classList.contains('dpX')) setMode(false);
  });
  pickInput.addEventListener('input', () => setColor(pickInput.value, false));
  pickInput.addEventListener('change', () => setColor(pickInput.value, true));
  q('.dpSize').addEventListener('input', () => setSize(Number(q('.dpSize').value)));
  q('.dpOp').addEventListener('input', () => { toolPref(prefs.tool).opacity = Number(q('.dpOp').value) || 100; applyPrefs(); savePrefs(); });
  q('.dpFill').addEventListener('change', () => { prefs.fillShapes = q('.dpFill').checked; applyPrefs(); savePrefs(); });
  q('.dpShow').addEventListener('change', () => engine.setShowOthers(q('.dpShow').checked));

  function renderPanel() {
    const tp = toolPref(prefs.tool);
    for (const b of panel.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === prefs.tool);
    for (const b of panel.querySelectorAll('.dpColors [data-c]')) b.classList.toggle('on', b.dataset.c === prefs.color);
    q('.dpRecent').replaceChildren(...prefs.recent.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `dpSw${c === prefs.color ? ' on' : ''}`;
      b.dataset.c = c;
      b.style.background = c;
      b.title = c;
      return b;
    }));
    pickInput.value = prefs.color;
    q('.dpSize').value = String(tp.size);
    q('.dpSizeV').textContent = String(tp.size);
    q('.dpOp').value = String(tp.opacity);
    q('.dpOpV').textContent = `${tp.opacity}%`;
    q('.dpOp').disabled = prefs.tool === 'eraser';
    q('.dpFill').checked = prefs.fillShapes;
    q('[data-act="undo"]').disabled = !engine.canUndo();
    q('[data-act="redo"]').disabled = !engine.canRedo();
    layer.classList.toggle('cross', prefs.tool === 'fill' || DRAW.SHAPES.includes(prefs.tool));
  }

  // ---------------------------------------------------------------- desenhar com mouse, caneta ou dedo
  let pointer = null;
  const xy = (e) => {
    const r = layer.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / (r.width || 1)) * 10000, y: ((e.clientY - r.top) / (r.height || 1)) * 10000 };
  };
  layer.addEventListener('pointerdown', (e) => {
    if (!mode || pointer != null || (e.pointerType === 'mouse' && e.button !== 0) || e.isPrimary === false) return;
    e.preventDefault();
    pointer = e.pointerId;
    layer.setPointerCapture?.(e.pointerId);
    const p = xy(e);
    engine.pointerDown(p.x, p.y, e.pointerType === 'pen' ? e.pressure : null, e.shiftKey);
    renderPanel();
    place();
  });
  // Enquanto desenha, o movimento e o soltar valem na janela toda: o traço (e a borracha) seguem o mouse mesmo
  // passando por cima do painel de desenho, das câmeras ou de fora do vídeo, sem depender da captura do ponteiro
  addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (pointer === e.pointerId) {
      // eventos agrupados pelo navegador: mais pontos = curva mais fiel em traço rápido
      const all = e.getCoalescedEvents?.() || [];
      const list = all.length ? all : [e];
      const pen = e.pointerType === 'pen';
      engine.pointerMove(list.map((ev) => ({ ...xy(ev), pressure: pen ? ev.pressure : null, t: ev.timeStamp })), e.shiftKey);
    } else if (pointer == null && layer.contains(e.target)) {
      const p = xy(e);
      engine.hover(p.x, p.y);
    }
  });
  const up = (e) => {
    if (pointer !== e.pointerId) return;
    pointer = null;
    if (e.type === 'pointercancel') engine.cancel();
    else { const p = xy(e); engine.pointerUp(p.x, p.y); }
    renderPanel();
  };
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  layer.addEventListener('pointerleave', () => { if (mode && pointer == null) engine.hover(null); });
  // no modo desenho, o clique duplo não põe o vídeo em tela cheia
  layer.addEventListener('dblclick', (e) => { if (mode) e.stopPropagation(); });

  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && document.activeElement.type !== 'range';
    if (!mode || typing) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') setMode(false);
    else if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) engine.undo();
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) engine.redo();
    else if (k === '[') setSize(toolPref(prefs.tool).size - 2);
    else if (k === ']') setSize(toolPref(prefs.tool).size + 2);
    else return;
    e.preventDefault();
    renderPanel();
  });

  // ---------------------------------------------------------------- ligar e desligar o modo desenho
  const buttons = [];
  function setMode(on) {
    if (on && !role()) {
      toast('Comece uma transmissão ou entre numa para desenhar na tela.', true);
      return;
    }
    if (on && role() === 'viewer') window.Room?.setPointing(false);
    mode = !!on;
    if (!mode) { pointer = null; engine.cancel(); engine.hover(null); disarm(); }
    layer.classList.toggle('on', mode);
    if (mode) { wrap().append(panel); applyPrefs(); } else panel.remove();
    for (const b of buttons) {
      b.classList.toggle('on', mode);
      b.setAttribute('aria-pressed', String(mode));
    }
    $('drawBtn').textContent = mode ? 'Parar de desenhar' : 'Desenhar na tela';
    $('drawBtn').classList.toggle('primary', mode);
    place();
  }
  const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20z"/><path d="M14 7l3 3"/></svg>';
  for (const [spot, cls] of [[$('reactBar'), 'reactBtn voiceQuick drawQuick'], [$('copyInvite'), 'iconBtn voiceQuick drawQuick']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = PEN;
    b.title = 'Desenhar na tela';
    b.setAttribute('aria-label', 'Desenhar na tela');
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setMode(!mode));
    if (spot.id === 'copyInvite') spot.before(b);
    else spot.append(b);
    buttons.push(b);
  }
  $('drawBtn').addEventListener('click', () => setMode(!mode));

  // ---------------------------------------------------------------- ciclo de vida (chamado por app.js e room.js)
  function onViewerJoin(code) {
    for (const strokes of snapshotChunks()) send(code, { t: 'draw-snap', strokes });
  }
  // Saiu da sala ou parou de transmitir: some tudo (sem avisar ninguém)
  function reset() {
    setMode(false);
    engine.reset();
    buckets.clear();
    window.telinha.overlayDraw?.({ op: 'reset' });
    place();
  }

  applyPrefs();
  return { onMessage, onViewerJoin, onStop: reset, setMode, get mode() { return mode; }, engine };
})();
window.Draw = Draw;
