// Telinha · motor de desenho na tela. Veio do motor do Crunchy Sync (draw.js + as regras de desenho do
// common.js), sem mudanças de comportamento: modelo dos traços, validação do que chega pela rede e desenho
// no canvas 2D. Coordenadas 0–10000 relativas à imagem do vídeo. Usado pela janela principal (draw.js) e
// pela janela por cima da tela de quem transmite (overlay.js).
globalThis.DrawEngine = globalThis.DrawEngine || (() => {
  // Coordenadas vão de 0 a 10000 relativas à imagem do vídeo (sem as faixas pretas): o desenho cai
  // no mesmo lugar em qualquer tamanho de tela. Pontos de traço livre: [x, y, pressão 0–100, ...].
  const DRAW = {
    FREE: ['pen', 'pencil', 'marker', 'eraser'],
    SHAPES: ['line', 'arrow', 'rect', 'ellipse'],
    MAX_PTS: 2000,          // pontos por traço
    MAX_PTS_MSG: 300,       // pontos por mensagem
    MAX_STROKES: 400,       // traços na tela (passou disso, some o mais antigo)
    TOTAL_PTS: 120000,      // pontos somando todos os traços
    MAX_FILLS: 40,          // baldes de tinta na tela
    RATE: 60, BURST: 160    // mensagens de desenho por segundo por pessoa (média e pico)
  };
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // maxValues = quantos números cabem (3 por ponto)
  function cleanPts(pts, maxValues) {
    if (!Array.isArray(pts)) return [];
    const n = Math.min(pts.length - (pts.length % 3), Math.max(0, maxValues - (maxValues % 3)));
    const out = [];
    for (let i = 0; i < n; i += 3) {
      const x = Number(pts[i]), y = Number(pts[i + 1]), p = Number(pts[i + 2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push(clampN(Math.round(x), 0, 10000), clampN(Math.round(y), 0, 10000), Number.isFinite(p) ? clampN(Math.round(p), 0, 100) : 100);
    }
    return out;
  }
  // Valida um traço vindo da rede. Devolve só os campos conhecidos, já limitados, ou null.
  function cleanStroke(m) {
    if (!m || typeof m !== 'object') return null;
    const sid = String(m.sid || '');
    if (!/^[a-z0-9]{1,16}$/.test(sid)) return null;
    const tool = String(m.tool || '');
    const color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? String(m.color).toLowerCase() : '#000000';
    const size = clampN(Number(m.size) || 1, 1, 60);
    const opacity = clampN(Number(m.opacity) || 1, 0.05, 1);
    if (DRAW.FREE.includes(tool)) return { sid, tool, color, size, opacity, pts: cleanPts(m.pts, DRAW.MAX_PTS * 3) };
    if (DRAW.SHAPES.includes(tool)) {
      if (!Array.isArray(m.a) || m.a.length !== 4) return null;
      const a = m.a.map(v => clampN(Math.round(Number(v) || 0), 0, 10000));
      return { sid, tool, color, size, opacity, a, fill: !!m.fill && (tool === 'rect' || tool === 'ellipse') };
    }
    if (tool === 'fill') {
      return { sid, tool, color, size, opacity, x: clampN(Math.round(Number(m.x) || 0), 0, 10000), y: clampN(Math.round(Number(m.y) || 0), 0, 10000) };
    }
    return null;
  }
  const strokeCost = s => (s.pts ? s.pts.length / 3 : 1);
  const UNIT = 720;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ======================================================================
  //  Desenho no canvas
  // ======================================================================
  function lineWidthOf(s, H) {
    const k = s.size * H / UNIT;
    switch (s.tool) {
      case 'marker': return k * 2.2;
      case 'pencil': return k * 0.55;
      case 'eraser': return k * 2.5;
      default: return k;
    }
  }
  // espessura conforme a pressão da caneta (ou a velocidade do mouse, no pincel)
  function widthAt(s, base, p) {
    if (s.tool === 'pen') return base * (0.15 + 0.85 * p / 100);
    if (s.tool === 'pencil') return base * (0.6 + 0.4 * p / 100);
    return base;
  }
  const variableWidth = s => s.tool === 'pen' || s.tool === 'pencil';

  // pedaços curvos ligando os pontos médios: o traço sai suave mesmo com poucos pontos
  function segments(c, s, W, H, from) {
    const p = s.pts, n = p.length / 3, base = lineWidthOf(s, H);
    const X = i => p[i * 3] / 10000 * W, Y = i => p[i * 3 + 1] / 10000 * H;
    for (let i = Math.max(0, from || 0); i < n; i++) {
      const ax = i === 0 ? X(0) : (X(i - 1) + X(i)) / 2, ay = i === 0 ? Y(0) : (Y(i - 1) + Y(i)) / 2;
      const bx = i === n - 1 ? X(i) : (X(i) + X(i + 1)) / 2, by = i === n - 1 ? Y(i) : (Y(i) + Y(i + 1)) / 2;
      c.lineWidth = Math.max(0.5, widthAt(s, base, p[i * 3 + 2]));
      c.beginPath();
      c.moveTo(ax, ay);
      c.quadraticCurveTo(X(i), Y(i), bx, by);
      c.stroke();
    }
  }
  function smoothPath(c, s, W, H) {
    const p = s.pts, n = p.length / 3;
    const X = i => p[i * 3] / 10000 * W, Y = i => p[i * 3 + 1] / 10000 * H;
    c.beginPath();
    c.moveTo(X(0), Y(0));
    for (let i = 1; i < n - 1; i++) c.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    c.lineTo(X(n - 1), Y(n - 1));
  }
  function bbox(s, W, H, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i] / 10000 * W, y = s.pts[i + 1] / 10000 * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  function drawFree(c, s, W, H, scratch, from) {
    const n = s.pts.length / 3;
    if (!n) return;
    const base = lineWidthOf(s, H);
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (s.tool === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = c.fillStyle = '#000';
      if (n === 1) { c.beginPath(); c.arc(s.pts[0] / 10000 * W, s.pts[1] / 10000 * H, base / 2, 0, Math.PI * 2); c.fill(); }
      else segments(c, s, W, H, from);
      c.restore();
      return;
    }
    c.strokeStyle = c.fillStyle = s.color;
    if (n === 1) {
      c.globalAlpha = s.opacity;
      c.beginPath();
      c.arc(s.pts[0] / 10000 * W, s.pts[1] / 10000 * H, Math.max(0.5, widthAt(s, base, s.pts[2]) / 2), 0, Math.PI * 2);
      c.fill();
    } else if (!variableWidth(s)) {
      // um caminho só: transparência uniforme, sem manchas onde o traço cruza
      c.globalAlpha = s.opacity;
      c.lineWidth = base;
      smoothPath(c, s, W, H);
      c.stroke();
    } else if (s.opacity >= 0.999 || !scratch) {
      c.globalAlpha = s.opacity;
      segments(c, s, W, H, 0);
    } else {
      // espessura variável + transparência: monta opaco à parte e cola com a transparência
      const b = bbox(s, W, H, base + 2);
      const sc = scratch(W, H), sx = sc.getContext('2d');
      sx.clearRect(b.x, b.y, b.w, b.h);
      sx.save();
      sx.lineCap = 'round'; sx.lineJoin = 'round';
      sx.strokeStyle = s.color;
      segments(sx, s, W, H, 0);
      sx.restore();
      c.globalAlpha = s.opacity;
      c.drawImage(sc, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
      sx.clearRect(b.x, b.y, b.w, b.h);
    }
    c.restore();
  }

  // alinha a forma (Shift): ângulo de 15 em 15 graus, quadrado e círculo
  function constrain(tool, a, W, H) {
    const [x1, y1, x2, y2] = a;
    const dx = (x2 - x1) / 10000 * W, dy = (y2 - y1) / 10000 * H;
    if (tool === 'line' || tool === 'arrow') {
      const len = Math.hypot(dx, dy), step = Math.PI / 12;
      const ang = Math.round(Math.atan2(dy, dx) / step) * step;
      return [x1, y1, x1 + Math.cos(ang) * len / W * 10000, y1 + Math.sin(ang) * len / H * 10000];
    }
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return [x1, y1, x1 + Math.sign(dx || 1) * m / W * 10000, y1 + Math.sign(dy || 1) * m / H * 10000];
  }

  function drawShape(c, s, W, H) {
    const x1 = s.a[0] / 10000 * W, y1 = s.a[1] / 10000 * H, x2 = s.a[2] / 10000 * W, y2 = s.a[3] / 10000 * H;
    const lw = Math.max(0.5, lineWidthOf(s, H));
    c.save();
    c.globalAlpha = s.opacity;
    c.strokeStyle = c.fillStyle = s.color;
    c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    if (s.tool === 'line' || s.tool === 'arrow') {
      c.moveTo(x1, y1); c.lineTo(x2, y2);
      if (s.tool === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1), dist = Math.hypot(x2 - x1, y2 - y1);
        const head = Math.min(dist * 0.45, Math.max(lw * 3.5, 14 * H / UNIT));
        for (const d of [-0.5, 0.5]) { c.moveTo(x2, y2); c.lineTo(x2 - head * Math.cos(ang + d), y2 - head * Math.sin(ang + d)); }
      }
      c.stroke();
    } else {
      if (s.tool === 'rect') c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      if (s.fill) c.fill(); else c.stroke();
    }
    c.restore();
  }

  // balde de tinta: pinta a área parecida com o ponto clicado, até as bordas dos traços
  function floodFill(c, s, W, H, scratch) {
    if (!W || !H || W * H > 9e6 || !scratch) return;
    const x = clamp(Math.floor(s.x / 10000 * W), 0, W - 1), y = clamp(Math.floor(s.y / 10000 * H), 0, H - 1);
    const d = c.getImageData(0, 0, W, H).data;
    const i0 = (y * W + x) * 4, tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
    const match = ta < 24
      ? j => d[j + 3] < 64
      : j => Math.max(Math.abs(d[j] - tr), Math.abs(d[j + 1] - tg), Math.abs(d[j + 2] - tb), Math.abs(d[j + 3] - ta)) <= 48;
    const mask = new Uint8Array(W * H);
    let minX = x, maxX = x, minY = y, maxY = y;
    const stack = [x, y];
    while (stack.length) {
      const yy = stack.pop(); let xx = stack.pop();
      const row = yy * W;
      while (xx >= 0 && !mask[row + xx] && match((row + xx) * 4)) xx--;
      xx++;
      let up = false, down = false;
      while (xx < W && !mask[row + xx] && match((row + xx) * 4)) {
        mask[row + xx] = 1;
        if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
        if (yy > 0) {
          const ok = !mask[row - W + xx] && match((row - W + xx) * 4);
          if (ok && !up) { stack.push(xx, yy - 1); up = true; } else if (!ok) up = false;
        }
        if (yy < H - 1) {
          const ok = !mask[row + W + xx] && match((row + W + xx) * 4);
          if (ok && !down) { stack.push(xx, yy + 1); down = true; } else if (!ok) down = false;
        }
        xx++;
      }
    }
    // cresce 1 px para cobrir a borda suavizada dos traços (sem fresta branca)
    const bx = Math.max(0, minX - 1), by = Math.max(0, minY - 1);
    const bw = Math.min(W, maxX + 2) - bx, bh = Math.min(H, maxY + 2) - by;
    const sc = scratch(W, H), sx = sc.getContext('2d');
    const out = sx.createImageData(bw, bh), o = out.data;
    const r = parseInt(s.color.slice(1, 3), 16), g = parseInt(s.color.slice(3, 5), 16), b = parseInt(s.color.slice(5, 7), 16);
    for (let yy = 0; yy < bh; yy++) {
      const gy = by + yy;
      for (let xx = 0; xx < bw; xx++) {
        const gx = bx + xx, k = gy * W + gx;
        if (mask[k] || (gx > 0 && mask[k - 1]) || (gx < W - 1 && mask[k + 1]) || (gy > 0 && mask[k - W]) || (gy < H - 1 && mask[k + W])) {
          const j = (yy * bw + xx) * 4;
          o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = 255;
        }
      }
    }
    sx.clearRect(0, 0, bw, bh);
    sx.putImageData(out, 0, 0);
    c.save();
    c.globalAlpha = s.opacity;
    c.drawImage(sc, 0, 0, bw, bh, bx, by, bw, bh);
    c.restore();
    sx.clearRect(0, 0, bw, bh);
  }

  function renderStroke(c, s, W, H, scratch) {
    if (s.pts) drawFree(c, s, W, H, scratch, 0);
    else if (s.a) drawShape(c, s, W, H);
    else if (s.tool === 'fill') floodFill(c, s, W, H, scratch);
  }

  // ======================================================================
  //  Controle: traços seus e dos outros
  // ======================================================================
  // opts: send(data) manda para a sala; raf(fn) agenda um quadro; now() relógio em ms
  function create(opts) {
    const send = opts.send || (() => {});
    const raf = opts.raf || (fn => setTimeout(fn, 16));
    const now = opts.now || (() => Date.now());
    const st = {
      strokes: [],          // na tela, na ordem (inclui borracha em andamento)
      live: new Map(),      // traços em andamento (fora da borracha)
      index: new Map(),     // key -> traço (strokes + live)
      showOthers: true,
      W: 0, H: 0, base: null, liveCv: null, scratchCv: null,
      undo: [], redo: [],
      tool: 'pen', color: '#ff3b30', size: 6, opacity: 1, fillShapes: false,
      cur: null, preview: null, cursor: null,
      pending: [], flushTimer: null, sm: null, lastIn: null,
      rafOn: false
    };
    const prefix = Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, 'x');
    let seq = 0;
    const newSid = () => (prefix + (++seq).toString(36)).slice(0, 16);
    const visible = s => s.by === 'me' || st.showOthers;
    const bctx = () => st.base && st.base.getContext('2d');
    const lctx = () => st.liveCv && st.liveCv.getContext('2d');
    const scratch = (W, H) => {
      if (!st.scratchCv) st.scratchCv = opts.makeCanvas ? opts.makeCanvas() : null;
      if (!st.scratchCv) return null;
      if (st.scratchCv.width !== W || st.scratchCv.height !== H) { st.scratchCv.width = W; st.scratchCv.height = H; }
      return st.scratchCv;
    };
    const scratchFn = opts.makeCanvas ? scratch : null;
    const wire = s => {
      const w = { sid: s.sid, tool: s.tool, color: s.color, size: s.size, opacity: s.opacity };
      if (s.pts) w.pts = s.pts.slice();
      if (s.a) { w.a = s.a.slice(); w.fill = !!s.fill; }
      if (s.tool === 'fill') { w.x = s.x; w.y = s.y; }
      return w;
    };

    // ---------- canvas ----------
    function setCanvases(base, live) { st.base = base; st.liveCv = live; }
    function resize(W, H) {
      W = Math.max(0, Math.round(W)); H = Math.max(0, Math.round(H));
      if (W === st.W && H === st.H) return false;
      st.W = W; st.H = H;
      if (st.base) { st.base.width = W; st.base.height = H; }
      if (st.liveCv) { st.liveCv.width = W; st.liveCv.height = H; }
      redrawAll();
      return true;
    }
    function redrawAll() {
      const c = bctx();
      if (c && st.W && st.H) {
        c.clearRect(0, 0, st.W, st.H);
        for (const s of st.strokes) if (visible(s)) renderStroke(c, s, st.W, st.H, scratchFn);
      }
      paintLive();
    }
    function paintLive() {
      if (st.rafOn || !st.W || !st.H) return;   // sem camada visível não há o que pintar (fora de sala: zero timers)
      st.rafOn = true;
      raf(() => { st.rafOn = false; drawLive(); });
    }
    function drawLive() {
      const c = lctx();
      if (!c || !st.W || !st.H) return;
      const W = st.W, H = st.H;
      c.clearRect(0, 0, W, H);
      for (const s of st.live.values()) if (visible(s)) drawFree(c, s, W, H, scratchFn, 0);
      if (st.preview) drawShape(c, st.preview, W, H);
      // nome de quem está desenhando, na ponta do traço
      c.save();
      c.font = `600 ${Math.round(Math.max(11, 12 * H / UNIT))}px system-ui, sans-serif`;
      for (const s of st.live.values()) {
        if (s.by === 'me' || !visible(s) || !s.name || !s.pts.length) continue;
        const n = s.pts.length / 3 - 1, x = s.pts[n * 3] / 10000 * W + 10, y = s.pts[n * 3 + 1] / 10000 * H - 10;
        const tw = c.measureText(s.name).width;
        c.globalAlpha = 0.75; c.fillStyle = '#000';
        c.fillRect(x - 4, y - 13, tw + 8, 18);
        c.globalAlpha = 1; c.fillStyle = '#fff';
        c.fillText(s.name, x, y);
      }
      c.restore();
      // cursor: anel do tamanho do pincel
      if (st.cursor && (!st.cur || st.cur.tool === 'eraser')) {
        const fake = { tool: st.tool === 'fill' || DRAW.SHAPES.includes(st.tool) ? 'pen' : st.tool, size: st.size };
        const r = Math.max(2, lineWidthOf(fake, H) / 2);
        const x = st.cursor.x / 10000 * W, y = st.cursor.y / 10000 * H;
        c.save();
        c.lineWidth = 1.5; c.strokeStyle = 'rgba(0,0,0,.7)';
        c.beginPath(); c.arc(x, y, r + 1, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = st.tool === 'eraser' ? '#fff' : st.color;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
        c.restore();
      }
    }
    function commitToBase(s) {
      const c = bctx();
      if (c && st.W && st.H && visible(s)) renderStroke(c, s, st.W, st.H, scratchFn);
    }

    // ---------- lista de traços ----------
    function totals() {
      let pts = 0, fills = 0;
      for (const s of st.index.values()) { pts += strokeCost(s); if (s.tool === 'fill') fills++; }
      return { pts, fills, count: st.index.size };
    }
    // mesmos limites do anfitrião: passou, some o mais antigo
    function enforceLimits() {
      let t = totals(), dropped = false;
      while (st.strokes.length && (t.count > DRAW.MAX_STROKES || t.pts > DRAW.TOTAL_PTS || t.fills > DRAW.MAX_FILLS)) {
        const s = st.strokes.shift();
        st.index.delete(s.key);
        t.count--; t.pts -= strokeCost(s); if (s.tool === 'fill') t.fills--;
        dropped = true;
      }
      if (dropped) redrawAll();
    }
    // traço novo: borracha e traços prontos vão para a base; o resto fica na camada "ao vivo"
    function addStroke(s) {
      st.index.set(s.key, s);
      if (s.done || s.tool === 'eraser') {
        st.strokes.push(s);
        commitToBase(s);
      } else {
        st.live.set(s.key, s);
        paintLive();
      }
      enforceLimits();
    }
    function endStroke(s) {
      if (s.done) return;
      s.done = true;
      if (st.live.delete(s.key)) {
        st.strokes.push(s);
        commitToBase(s);
        paintLive();
      }
    }
    function removeKeys(pred) {
      let any = false;
      for (const [k, s] of [...st.index]) {
        if (!pred(s)) continue;
        any = true;
        st.index.delete(k);
        st.live.delete(k);
        if (st.cur === s) abortCur();
      }
      if (any) { st.strokes = st.strokes.filter(s => st.index.has(s.key)); redrawAll(); }
      return any;
    }
    function abortCur() {
      clearTimeout(st.flushTimer);
      st.cur = null; st.pending = [];
    }

    // ---------- mensagens da sala ----------
    function remote(m) {
      if (!m || typeof m.by !== 'string') return;
      const by = m.by === st.you ? 'me' : m.by;
      const key = by + ':' + String(m.sid || '');
      switch (m.op) {
        case 'begin': case 'add': {
          const s = cleanStroke(m);
          if (!s || st.index.has(by + ':' + s.sid)) return;
          Object.assign(s, { key: by + ':' + s.sid, by, name: String(m.name || '').slice(0, 24), done: m.op === 'add' || !s.pts, at: now() });
          addStroke(s);
          break;
        }
        case 'pts': {
          const s = st.index.get(key);
          if (!s || s.done || !s.pts) return;
          const pts = cleanPts(m.pts, Math.min(DRAW.MAX_PTS_MSG * 3, DRAW.MAX_PTS * 3 - s.pts.length));
          if (!pts.length) return;
          const from = s.pts.length / 3 - 1;
          for (const v of pts) s.pts.push(v);
          s.at = now();
          if (s.tool === 'eraser') { const c = bctx(); if (c && visible(s) && st.W) drawFree(c, s, st.W, st.H, null, from); }
          else paintLive();
          break;
        }
        case 'end': { const s = st.index.get(key); if (s) endStroke(s); break; }
        case 'undo': removeKeys(s => s.key === key); break;
        case 'clear':
          if (m.scope === 'all') { removeKeys(() => true); st.undo = []; st.redo = []; }
          else removeKeys(s => s.by === by);
          break;
      }
    }
    // tudo o que já estava na tela (quem chegou agora, ou anfitrião novo): junta sem duplicar
    function snapshot(m) {
      if (!m || !Array.isArray(m.strokes)) return;
      if (typeof m.you === 'string') st.you = m.you;
      for (const w of m.strokes) {
        if (!w || typeof w.by !== 'string') continue;
        const s = cleanStroke(w);
        if (!s) continue;
        const by = w.by === st.you ? 'me' : w.by;
        const key = by + ':' + s.sid;
        if (st.index.has(key)) continue;
        Object.assign(s, { key, by, name: String(w.name || '').slice(0, 24), done: !!w.done || !s.pts, at: now() });
        addStroke(s);
      }
    }
    // traço de alguém que parou de chegar (caiu no meio): fica como está
    function tick() {
      const t = now();
      for (const s of [...st.live.values()]) if (s.by !== 'me' && t - (s.at || 0) > 15000) endStroke(s);
    }

    // ---------- seus traços ----------
    function flush() {
      clearTimeout(st.flushTimer); st.flushTimer = null;
      if (!st.cur || !st.pending.length) return;
      while (st.pending.length) send({ type: 'draw', op: 'pts', sid: st.cur.sid, pts: st.pending.splice(0, DRAW.MAX_PTS_MSG * 3) });
    }
    const SMOOTH = { pen: 0.45, pencil: 0.3, marker: 0.5, eraser: 0.2 };
    // x, y em 0–10000; pressure 0–1 (caneta) ou null (mouse); t em ms
    function pointerDown(x, y, pressure, shift) {
      if (!st.W || !st.H) return;
      x = clamp(x, 0, 10000); y = clamp(y, 0, 10000);
      st.redo = [];
      const base = { sid: newSid(), tool: st.tool, color: st.color, size: st.size, opacity: st.opacity, by: 'me', name: '', at: now() };
      if (st.tool === 'fill') {
        const s = { ...base, x: Math.round(x), y: Math.round(y), done: true };
        s.key = 'me:' + s.sid;
        addStroke(s); st.undo.push(s.key);
        send({ type: 'draw', op: 'add', ...wire(s) });
        return;
      }
      if (DRAW.SHAPES.includes(st.tool)) {
        st.preview = { ...base, a: [x, y, x, y], fill: st.fillShapes && (st.tool === 'rect' || st.tool === 'ellipse'), shift };
        st.cur = st.preview;
        paintLive();
        return;
      }
      const p = pressure == null ? 100 : clamp(Math.round((pressure || 0.5) * 100), 1, 100);
      const s = { ...base, pts: [Math.round(x), Math.round(y), p], done: false };
      s.key = 'me:' + s.sid;
      st.cur = s;
      st.sm = { x, y, p };
      st.lastIn = { x, y, t: now() };
      addStroke(s);
      send({ type: 'draw', op: 'begin', ...wire(s) });
    }
    // pts: [{ x, y, pressure, t }]
    function pointerMove(pts, shift) {
      const s = st.cur;
      if (!s) return;
      const last = pts[pts.length - 1];
      if (s.a) {
        const a = [s.a[0], s.a[1], clamp(last.x, 0, 10000), clamp(last.y, 0, 10000)];
        s.a = shift ? constrain(s.tool, a, st.W, st.H) : a;
        paintLive();
        return;
      }
      const W = st.W, H = st.H, k = SMOOTH[s.tool] ?? 0.4;
      const from = s.pts.length / 3 - 1;
      for (const q of pts) {
        if (s.pts.length >= DRAW.MAX_PTS * 3) break;
        const sm = st.sm;
        const x = sm.x + (clamp(q.x, 0, 10000) - sm.x) * (1 - k), y = sm.y + (clamp(q.y, 0, 10000) - sm.y) * (1 - k);
        let target;
        if (q.pressure == null) {
          // mouse no pincel: mais rápido = mais fino (parece pincel de verdade)
          const dt = Math.max(1, (q.t ?? now()) - st.lastIn.t);
          const speed = Math.hypot((q.x - st.lastIn.x) / 10000 * W, (q.y - st.lastIn.y) / 10000 * H) / dt;
          target = s.tool === 'pen' ? clamp(100 - speed * 22, 35, 100) : 100;
        } else target = clamp((q.pressure || 0.5) * 100, 1, 100);
        st.lastIn = { x: q.x, y: q.y, t: q.t ?? now() };
        const p = sm.p * 0.6 + target * 0.4;
        st.sm = { x, y, p };
        const lx = s.pts[s.pts.length - 3], ly = s.pts[s.pts.length - 2];
        if (Math.hypot((x - lx) / 10000 * W, (y - ly) / 10000 * H) < 1.5) continue; // perto demais do anterior
        const pt = [Math.round(x), Math.round(y), Math.round(p)];
        s.pts.push(...pt);
        st.pending.push(...pt);
      }
      if (s.tool === 'eraser') {
        const c = bctx();
        if (c) drawFree(c, s, W, H, null, from);
        // a borracha não deixa traço visível: o anel do cursor acompanha o mouse enquanto apaga
        st.cursor = { x: st.lastIn.x, y: st.lastIn.y };
        paintLive();
      } else paintLive();
      if (!st.flushTimer && st.pending.length) st.flushTimer = setTimeout(flush, 50);
    }
    function pointerUp(x, y) {
      const s = st.cur;
      if (!s) return;
      if (s.a) {
        st.preview = null; st.cur = null;
        const dx = (s.a[2] - s.a[0]) / 10000 * st.W, dy = (s.a[3] - s.a[1]) / 10000 * st.H;
        paintLive();
        if (Math.hypot(dx, dy) < 3) return; // clique sem arrastar: nada
        const shape = { sid: s.sid, tool: s.tool, color: s.color, size: s.size, opacity: s.opacity, a: s.a.map(v => Math.round(clamp(v, 0, 10000))), fill: s.fill, by: 'me', name: '', done: true, key: 'me:' + s.sid };
        addStroke(shape); st.undo.push(shape.key);
        send({ type: 'draw', op: 'add', ...wire(shape) });
        return;
      }
      if (x != null && s.pts.length < DRAW.MAX_PTS * 3) {
        const lx = s.pts[s.pts.length - 3], ly = s.pts[s.pts.length - 2];
        if (Math.hypot((x - lx) / 10000 * st.W, (y - ly) / 10000 * st.H) >= 1.5) {
          const pt = [Math.round(clamp(x, 0, 10000)), Math.round(clamp(y, 0, 10000)), Math.round(st.sm.p)];
          s.pts.push(...pt); st.pending.push(...pt);
        }
      }
      flush();
      send({ type: 'draw', op: 'end', sid: s.sid });
      st.cur = null;
      endStroke(s);
      if (s.tool === 'eraser') s.done = true;
      st.undo.push(s.key);
    }
    function cancel() {
      if (!st.cur) return;
      if (st.cur.a) { st.preview = null; st.cur = null; paintLive(); return; }
      pointerUp();
    }
    function hover(x, y) { st.cursor = x == null ? null : { x, y }; paintLive(); }

    function undo() {
      if (st.cur) return false;
      while (st.undo.length) {
        const key = st.undo.pop(), s = st.index.get(key);
        if (!s) continue;
        removeKeys(x => x === s);
        st.redo.push(s);
        send({ type: 'draw', op: 'undo', sid: s.sid });
        return true;
      }
      return false;
    }
    function redo() {
      if (st.cur || !st.redo.length) return false;
      const old = st.redo.pop();
      const s = { ...old, pts: old.pts && old.pts.slice(), a: old.a && old.a.slice(), done: true };
      s.sid = newSid(); s.key = 'me:' + s.sid;
      addStroke(s); st.undo.push(s.key);
      send({ type: 'draw', op: 'add', ...wire(s) });
      return true;
    }
    function clearMine() {
      cancel();
      st.undo = []; st.redo = [];
      removeKeys(s => s.by === 'me');
      send({ type: 'draw', op: 'clear', scope: 'mine' });
    }
    function clearAll() {
      cancel();
      st.undo = []; st.redo = [];
      removeKeys(() => true);
      send({ type: 'draw', op: 'clear', scope: 'all' });
    }
    // saiu da sala: some tudo, sem avisar ninguém
    function reset() {
      abortCur();
      st.preview = null;
      st.strokes = []; st.live.clear(); st.index.clear(); st.undo = []; st.redo = []; st.you = null;
      redrawAll();
    }
    function setShowOthers(v) { v = !!v; if (v === st.showOthers) return; st.showOthers = v; redrawAll(); }
    function set(p) {
      if (p.tool) st.tool = p.tool;
      if (p.color && /^#[0-9a-f]{6}$/i.test(p.color)) st.color = p.color.toLowerCase();
      if (p.size != null) st.size = clamp(Number(p.size) || 1, 1, 60);
      if (p.opacity != null) st.opacity = clamp(Number(p.opacity) || 1, 0.05, 1);
      if (p.fillShapes != null) st.fillShapes = !!p.fillShapes;
      paintLive();
    }

    return {
      setCanvases, resize, redrawAll, remote, snapshot, tick,
      pointerDown, pointerMove, pointerUp, cancel, hover,
      undo, redo, clearMine, clearAll, reset, setShowOthers, set,
      get state() { return st; },
      get count() { return st.index.size; },
      get busy() { return !!st.cur; },
      canUndo: () => st.undo.some(k => st.index.has(k)),
      canRedo: () => st.redo.length > 0
    };
  }

  return { create, renderStroke, drawFree, drawShape, floodFill, constrain, lineWidthOf, DRAW, cleanStroke, cleanPts };
})();
