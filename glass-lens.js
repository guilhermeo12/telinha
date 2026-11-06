/* Telinha · tema Vidro: a lente do Glisse (portada sem React) nos controles que
   ficam sobre o vídeo, onde há detalhe para dobrar. Um mapa calculado para a forma de cada controle dobra o fundo
   na borda, separando as cores. Só no Chromium: os outros navegadores não aplicam filtro SVG no fundo ao vivo.

   O cálculo dos mapas e o filtro vêm do Glisse (https://github.com/0kzh/glisse), licença MIT:
   Copyright (c) 2026 Kelvin Zhang. Permission is hereby granted, free of charge, to any person obtaining a copy of
   this software and associated documentation files (the "Software"), to deal in the Software without restriction,
   including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
   conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */
'use strict';

const GlassLens = (() => {
  const LENS = '.videoWrap .reactBtn, .videoWrap .btn, .videoWrap .unmuteBtn';
  // Os valores do vidro livre do Glisse: faixa da borda de 1/4 do lado menor, domo de 1/2, alcance de 0,45
  const STRENGTH = 0.45, DISPERSION = 0.4, DEPTH = 0.25, DOME = 0.5;
  const NS = 'http://www.w3.org/2000/svg';
  const refracts = /Chrom(?:e|ium)\//.test(navigator.userAgent);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const erf = (x) => Math.tanh(1.7724538509 * x); // erf(x) ≈ tanh(√π x)

  // Distância até um retângulo arredondado centrado na origem; negativa por dentro
  function distance(x, y, hw, hh, r) {
    const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  // O arco que afunda `sag` em `half`, escalado para a inclinação média ser 1/2
  function arc(sag, half) {
    const radius = (half * half + sag * sag) / (2 * sag);
    let sum = 0;
    for (let i = 0; i <= 200; i++) {
      const x = (i / 200) * half;
      const s = x / Math.sqrt(radius * radius - x * x);
      sum += i === 0 || i === 200 ? s / 2 : s;
    }
    const mean = sum / 200;
    return { radius, scale: mean > 0 ? 0.5 / mean : 1 };
  }
  const slope = (x, { radius, scale }) => {
    const inside = Math.min(x, 0.999 * radius);
    return (inside / Math.sqrt(radius * radius - inside * inside)) * scale;
  };

  // Tamanho e canto do elemento, em px; null enquanto ele não tem tamanho (tela escondida)
  function shapeOf(el, style) {
    const width = el.offsetWidth, height = el.offsetHeight;
    if (!width || !height) return null;
    const corner = style.borderTopLeftRadius;
    const radius = corner.endsWith('%') ? (Math.min(width, height) * parseFloat(corner)) / 100 : parseFloat(corner) || 0;
    return { width, height, radius: Math.min(width / 2, height / 2, radius) };
  }

  const canvas = document.createElement('canvas');
  function png(columns, rows, data) {
    canvas.width = columns;
    canvas.height = rows;
    const c = canvas.getContext('2d');
    const image = c.createImageData(columns, rows);
    image.data.set(data);
    c.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }

  // Dentro de uma faixa perto da borda, cada ponto mostra o conteúdo de mais para dentro, pela inclinação de um
  // domo raso. Cinzas, um para cada direção (cor seria convertida em tela de gama ampla e entortaria o desvio);
  // a máscara some onde o desvio some, para o meio mostrar o fundo exatamente como está.
  function lensMaps({ width, height, radius }, density) {
    const hw = width / 2, hh = height / 2;
    const columns = Math.max(1, Math.round(width * density)), rows = Math.max(1, Math.round(height * density));
    const across = new Uint8ClampedArray(columns * rows * 4), down = new Uint8ClampedArray(columns * rows * 4), mask = new Uint8ClampedArray(columns * rows * 4);
    const share = Math.min(width, height), depth = DEPTH * share, dome = DOME * share;
    const iw = Math.max(0, hw - depth), ih = Math.max(0, hh - depth), ir = clamp(radius, 0, Math.min(iw, ih));
    const ramp = depth > 0 ? 1 / (depth * Math.SQRT2) : 1e6;
    const sag = Math.max(0.01, Math.min(dome, Math.min(hw, hh) - 1));
    const arcX = arc(sag, hw), arcY = arc(sag, hh);
    const grey = (data, i, v) => { data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; };
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const i = (row * columns + column) * 4;
        const x = ((column + 0.5) / columns) * width - hw, y = ((row + 0.5) / rows) * height - hh;
        const edge = distance(x, y, hw, hh, radius);
        if (edge >= 0) {
          grey(across, i, 128);
          grey(down, i, 128);
          continue;
        }
        const falloff = 0.5 * (1 + erf(distance(x, y, iw, ih, ir) * ramp));
        grey(across, i, Math.round((0.5 - 0.5 * Math.sign(x) * slope(Math.abs(x), arcX) * falloff) * 255));
        grey(down, i, Math.round((0.5 - 0.5 * Math.sign(y) * slope(Math.abs(y), arcY) * falloff) * 255));
        mask[i + 3] = Math.round(255 * Math.min(1, falloff * 20, -edge));
      }
    }
    return { across: png(columns, rows, across), down: png(columns, rows, down), mask: png(columns, rows, mask) };
  }

  // O filtro: desloca o fundo uma vez para cada cor (o vermelho dobra mais que o azul) e usa isso só onde a máscara cobre
  let holder = null;
  function buildFilter(id, shape, density) {
    const { width, height } = shape;
    const maps = lensMaps(shape, density);
    const reach = STRENGTH * Math.min(width, height);
    const box = { x: 0, y: 0, width, height };
    const n = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };
    const f = n('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB', ...box });
    const matrix = (input, values, result) => n('feColorMatrix', { in: input, type: 'matrix', values, result });
    const add = (a, b, result) => n('feComposite', { in: a, in2: b, operator: 'arithmetic', k2: 1, k3: 1, result });
    for (const [href, result] of [[maps.across, 'across'], [maps.down, 'down'], [maps.mask, 'mask']]) {
      f.append(n('feImage', { href, preserveAspectRatio: 'none', result, ...box }));
    }
    f.append(n('feFlood', { 'flood-color': 'rgb(128, 128, 128)', result: 'neutral', ...box }));
    // Cada direção com alfa de 1/2 para a direção que ela não puxa
    for (const pull of ['across', 'down']) {
      const half = n('feComponentTransfer', { in: `${pull}Grey`, result: `${pull}Pull` });
      half.append(n('feFuncA', { type: 'linear', slope: 0, intercept: 0.5 }));
      f.append(n('feComposite', { in: pull, in2: 'neutral', operator: 'over', result: `${pull}Grey` }), half);
    }
    const channels = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0'];
    channels.forEach((channel, i) => {
      const scale = reach * [1 + 0.2 * DISPERSION, 1 + 0.1 * DISPERSION, 1][i];
      f.append(
        n('feDisplacementMap', { in: 'SourceGraphic', in2: 'acrossPull', scale, xChannelSelector: 'R', yChannelSelector: 'A', result: `a${i}`, ...box }),
        n('feDisplacementMap', { in: `a${i}`, in2: 'downPull', scale, xChannelSelector: 'A', yChannelSelector: 'R', result: `ray${i}` }),
        matrix(`ray${i}`, `${channel}  0 0 0 0.3333 0`, `light${i}`),
      );
    });
    f.append(
      add('light0', 'light1', 'light01'),
      add('light01', 'light2', 'spread'),
      matrix('spread', '3 0 0 0 0  0 3 0 0 0  0 0 3 0 0  0 0 0 1 0', 'bent'),
      n('feComposite', { in: 'bent', in2: 'mask', operator: 'in', result: 'inside' }),
      n('feComposite', { in: 'SourceGraphic', in2: 'mask', operator: 'out', result: 'outside' }),
      add('inside', 'outside', 'seen'),
    );
    holder.append(f);
  }

  // Tamanhos iguais dividem o mesmo filtro. Limite para redimensionar a janela não acumular mapas
  const filters = new Map();
  function fit(el) {
    if (!el.isConnected) return;
    const shape = shapeOf(el, getComputedStyle(el));
    if (!shape) return;
    const density = Math.min(devicePixelRatio || 1, 2);
    const key = [shape.width, shape.height, shape.radius, density].join('|');
    if (!filters.has(key)) {
      if (filters.size >= 128) {
        // Tira todos e refaz os que estão em uso
        filters.clear();
        holder.replaceChildren();
        document.querySelectorAll('.glLens').forEach(queue);
      }
      const id = `glass-lens-${++made}`;
      buildFilter(id, shape, density);
      filters.set(key, id);
    }
    el.style.setProperty('--lg-filter', `url("#${filters.get(key)}") saturate(1.5)`);
    el.classList.add('glLens');
  }
  let made = 0;

  // Ajusta quando a página está livre, e de novo a cada mudança de tamanho
  const waiting = new Set();
  let scheduled = false;
  function queue(el) {
    waiting.add(el);
    if (scheduled) return;
    scheduled = true;
    requestIdleCallback(() => {
      scheduled = false;
      const list = [...waiting];
      waiting.clear();
      if (on) list.forEach(fit);
    }, { timeout: 300 });
  }

  let on = false;
  const sizes = new ResizeObserver((entries) => { for (const e of entries) queue(e.target); });
  const within = (node, selector) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)];
  const added = new MutationObserver((changes) => {
    for (const change of changes) {
      for (const node of change.addedNodes) if (node.nodeType === 1) within(node, LENS).forEach((el) => sizes.observe(el));
      for (const node of change.removedNodes) if (node.nodeType === 1) within(node, LENS).forEach((el) => { sizes.unobserve(el); waiting.delete(el); });
    }
  });

  function set(next) {
    next = next && refracts; // fora do Chromium o tema é só o Vidro
    if (next === on) return;
    on = next;
    if (on) {
      if (!holder) {
        const s = document.createElementNS(NS, 'svg');
        s.setAttribute('class', 'glFilters');
        s.setAttribute('aria-hidden', 'true');
        holder = document.createElementNS(NS, 'defs');
        s.append(holder);
        document.body.append(s);
      }
      document.querySelectorAll(LENS).forEach((el) => sizes.observe(el));
      added.observe(document.body, { childList: true, subtree: true });
      return;
    }
    sizes.disconnect();
    added.disconnect();
    waiting.clear();
    for (const el of document.querySelectorAll('.glLens')) {
      el.classList.remove('glLens');
      el.style.removeProperty('--lg-filter');
    }
  }

  return { set, stats: () => ({ on, filters: filters.size, refracts }) };
})();
window.GlassLens = GlassLens;
