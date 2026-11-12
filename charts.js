// tasteskill / charts.js — small, dependency-free charts for app screens, drawn in SVG from your data.
// They follow references/app-screens.md: one question per chart, one series that matters, 3–5 quiet
// horizontal gridlines, round ticks that top out above the largest value, 2px straight lines with no
// markers, square bars, no gradients, a bare tooltip, tabular figures. Colours come from CSS variables:
//   --chart-1 … --chart-4 (series), --chart-muted (other series), --chart-mark (a marked period; ink by default),
//   --chart-span (the opacity of a shaded span: about .06 on light, .12 on dark), --chart-track (a time strip's track),
//   --grid, --axis-ink, --ink, --surface, --raised, --rule, --negative
// Usage (after this file loads):
//   Charts.line(el, { labels: ['1 Oct', …], series: [{ name: 'Requests', values: [...] }], format: Charts.fmt.compact })
// Telinha: só a tela Início usa um gráfico (line); os outros tipos da biblioteca original foram tirados.
// line takes annotations: [{ at: index, label: 'Deploy a3f09c1', short: 'a3f09c1' }] or spans
// [{ from, to, label: 'Cloud' }]. Their labels sit in rows above the plot, measured once the fonts have loaded, and no
// leader line crosses another label; the rows are reserved only when a label exists. reference: { value, label }, its
// label set where no series passes.
// line takes step: true for a balance that only changes on given days; today: index (the forecast after it is dashed)
// with todayLabel: 'Now 20:34' (set clear of the line); endLabel: true (the last value at the line's end); max: caps a
// flat series with one spike (the peak is labelled); yTicks: fixed ticks for a bounded quantity (0–100%); tickFormat:
// axis labels apart from the tooltip format; xAt: the indices to label. Without xAt the x labels keep one step.
// diverging, timeline, matrix and timeStrip return { svg, legend }, and line returns { legend } for two series or more:
// the legend is drawn from the same style objects as the marks, so a swatch is always the mark scaled down. Put it in
// the card's header, or pass legend: element (or a selector) to have it filled.
// Numbers follow the page's language (<html lang>). Every chart gets role="img" and an aria-label that states what it shows.
(() => {
  const NS = 'http://www.w3.org/2000/svg', MINUS = '\u2212', ROW = 14, LANE = (rows) => 8 + rows * ROW + (rows ? 4 : 0);
  const css = (el, name, fb) => getComputedStyle(el).getPropertyValue(name).trim() || fb;
  const cssNum = (el, name, fb) => { const v = parseFloat(css(el, name, '')); return Number.isFinite(v) ? v : fb; };
  // Telinha: o CSP do app (style-src 'self') bloqueia o atributo style; via CSSOM (style.cssText) é permitido
  const svg = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) { if (k === 'style') n.style.cssText = v; else n.setAttribute(k, v); } if (parent) parent.appendChild(n); return n; };
  const text = (parent, str, attrs) => { const t = svg('text', attrs, parent); t.textContent = str; return t; };
  const titled = (parent, str) => { svg('title', {}, parent).textContent = str; return parent; };
  // numbers follow the page's language (<html lang>), so separators match the rest of the screen
  const nf = (o) => new Intl.NumberFormat(document.documentElement.lang || 'en', o);
  const fmt = {
    int: (v) => nf({ maximumFractionDigits: 0 }).format(v),
    dec: (d) => (v) => nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(v),
    pct: (d = 1) => (v) => nf({ style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d }).format(v),
    money: (cur = 'EUR', d = 0) => (v) => nf({ style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(v),
    compact: (v) => nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v),
    ms: (v) => `${nf({ maximumFractionDigits: 0 }).format(v)} ms`,
    // a sign on every change, with a true minus: fmt.signed() → '+2', '0', '−1'; fmt.signed(fmt.dec(1)) → '+0.4'
    signed: (f = (v) => nf({ maximumFractionDigits: 0 }).format(v)) => (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + f(Math.abs(v)),
    // minutes since midnight as a 24-hour time: 680 → '11:20'
    clock: (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`, // taste-skill-ignore: a clock, not a counter
  };
  const minutes = (t) => (t == null || t === '' ? null : typeof t === 'number' ? t : (([hh, mm]) => hh * 60 + (mm || 0))(String(t).split(':').map(Number)));
  // Round ticks (steps of 1, 2, 2.5 or 5 × 10^n) whose top sits above the largest value.
  function ticks(min, max, count = 4) {
    if (max === min) max = min + 1;
    const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const lo = Math.floor(min / step) * step; let hi = Math.ceil(max / step) * step; if (hi <= max) hi += step;
    const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }
  // x labels keep one step all the way: every k-th label, with k chosen so the labels fit the width, and a step that
  // lands on the last label when one gives enough labels. Never a forced end label that breaks the step. Clock labels
  // ('08:30') step in whole hours (or halves and quarters) from a round time, so a half-hourly axis reads 06:00, 09:00.
  function xPicks(labels, span, at) {
    const n = labels.length;
    if (at) return at.filter((i) => i >= 0 && i < n);
    if (n <= 1) return n ? [0] : [];
    const longest = Math.max(...labels.map((l) => String(l).length));
    const cap = Math.max(2, Math.min(8, Math.floor(span / (longest * 7 + 18))));
    if (n <= cap) return [...Array(n).keys()];
    const mins = labels.every((l) => /^\d{1,2}:\d{2}$/.test(String(l))) ? labels.map(minutes) : null;
    const d = mins ? mins[1] - mins[0] : 0;
    let first = null, land = null;
    for (let k = 1; k < n; k++) {
      const stepM = k * d, clock = mins && d > 0;
      if (clock && (stepM >= 60 ? ![1, 2, 3, 4, 6, 12].includes(stepM / 60) : 60 % stepM !== 0)) continue;
      // start on a round time: a multiple of the step (09:00 for three hours), or a whole hour for shorter steps
      let s = clock ? mins.findIndex((m) => m % Math.max(60, stepM) === 0) : 0;
      if (s < 0) s = Math.max(0, mins.findIndex((m) => m % 60 === 0));
      const count = Math.floor((n - 1 - s) / k) + 1;
      if (count > cap) continue;
      if (first == null) first = { k, s };
      if ((n - 1 - s) % k === 0) { land = { k, s, count }; break; }
    }
    const pick = land && land.count >= Math.max(3, Math.ceil(cap * 0.6)) ? land : first || { k: n - 1, s: 0 };
    const out = []; for (let i = pick.s; i < n; i += pick.k) out.push(i);
    return out;
  }
  // colours: tokens resolved to rgb, so a mark can be mixed with the surface (a pale fill, a darker step)
  const swatchProbe = document.createElement('span'); swatchProbe.style.display = 'none';
  const rgb = (el, value) => {
    el.appendChild(swatchProbe); swatchProbe.style.color = ''; swatchProbe.style.color = value;
    const c = getComputedStyle(swatchProbe).color; swatchProbe.remove();
    const m = c.match(/-?[\d.]+/g); if (!m || m.length < 3) return null;
    return c.startsWith('color(') ? m.slice(0, 3).map((v) => Math.round(+v * 255)) : m.slice(0, 3).map(Number);
  };
  // text width, measured in the chart's own face (falls back to an estimate when the chart is hidden)
  const measure = (s, str, size = 11, weight = 400) => { const t = text(s, str, { x: -999, y: -999, 'font-size': size, 'font-weight': weight, visibility: 'hidden' }); let wd = 0; try { wd = t.getComputedTextLength(); } catch {} t.remove(); return wd > 0 ? wd : String(str).length * size * 0.56; };
  const fit = (s, str, max, size, weight) => { str = String(str); if (measure(s, str, size, weight) <= max) return str; while (str.length > 1 && measure(s, str + '\u2026', size, weight) > max) str = str.slice(0, -1); return str.trimEnd() + '\u2026'; };
  function frame(el, h) {
    el.innerHTML = '';
    const w = Math.max(240, el.clientWidth || 600);
    const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, role: 'img', style: 'display:block;overflow:visible;font-variant-numeric:tabular-nums' }, el);
    return { s, w, h };
  }
  function tooltip(el) {
    let t = el.querySelector('.chart-tip');
    if (!t) { t = document.createElement('div'); t.className = 'chart-tip'; t.style.cssText = 'position:absolute;pointer-events:none;padding:6px 8px;font:inherit;font-size:12px;line-height:1.35;border-radius:6px;white-space:nowrap;opacity:0;transition:opacity 120ms ease;background:var(--surface,#fff);color:var(--ink,#111);border:1px solid var(--grid,#e5e7eb)'; if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; el.appendChild(t); }
    return t;
  }
  function axes(g, el, { w, h, padL, padB, yt, y, labels, x, band = false, at = null, tick, avoid = null }) {
    const grid = css(el, '--grid', '#e8e8e8'), ink = css(el, '--axis-ink', '#6b6b6b'), s = g.ownerSVGElement;
    for (const v of yt) {
      const yy = y(v);
      svg('line', { x1: padL, x2: w, y1: yy, y2: yy, stroke: grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, g);
      text(g, tick(v), { x: padL - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 12, fill: ink });
    }
    const n = labels.length;
    for (const i of xPicks(labels, w - padL, at)) {
      const lab = String(labels[i]), tw = measure(s, lab, 12), xx = x(i);
      // the first and last labels are pulled inside the plot; none runs past either edge
      let left = band ? xx - tw / 2 : i === 0 ? xx : i === n - 1 ? xx - tw : xx - tw / 2;
      left = Math.max(band ? 0 : padL, Math.min(w - tw, left));
      if (avoid && left < avoid[1] + 8 && left + tw > avoid[0] - 8) continue;
      text(g, lab, { x: left, y: h - padB + 18, 'font-size': 12, fill: ink });
    }
  }
  // Annotation labels sit in rows above the plot, never on the data. A label sits beside the top of its own leader
  // line, right of it or left of it, in one of three rows. A place is free when no other label in that row overlaps
  // it, no leader line passes through it, and its own leader passes through no label below it. The layout is searched
  // (close markers often need the first label on the left so the next leader runs clear): full labels first, then
  // short forms (`short`), and only then is a label dropped to its marker's tooltip, with a note in the console.
  function lane(s, items, w, maxRows = 3) {
    const gap = 6, rank = (it) => (it.fixed != null ? 0 : it.span ? 1 : 2);
    // fixed captions first, then spans, then markers from left to right
    const order = [...items].sort((a, b) => rank(a) - rank(b) || (a.x ?? a.x0) - (b.x ?? b.x0));
    const opts = order.map((it) => {
      const out = [];
      for (const str of [it.label, it.short].filter(Boolean)) {
        const tw = measure(s, str, 11) + (it.glyph ? 9 : 0), mid = it.span ? (it.x0 + it.x1) / 2 : 0;
        const cands = it.fixed != null ? [[it.fixed, it.fixed + tw]] : it.span ? [[mid - tw / 2, mid + tw / 2], [it.x0, it.x0 + tw], [it.x1 - tw, it.x1]] : [[it.x + 4, it.x + 4 + tw], [it.x - 4 - tw, it.x - 4]];
        for (let row = 0; row < maxRows; row++) for (const [x0, x1] of cands) if (x0 >= 0 && x1 <= w) out.push({ ...it, text: str, isShort: str !== it.label, row, x0, x1 });
      }
      return out;
    });
    const free = (c, placed) => placed.every((p) => p.dropped || (!(p.row === c.row && c.x0 < p.x1 + gap && c.x1 > p.x0 - gap)
      && !(p.leader != null && p.row >= c.row && p.leader > c.x0 - 3 && p.leader < c.x1 + 3)
      && !(c.leader != null && p.row <= c.row && c.leader > p.x0 - 3 && c.leader < p.x1 + 3)));
    let best = null, steps = 0;
    const solve = (i, placed, allowShort, allowDrop) => {
      if (++steps > 20000) return false;
      if (i === order.length) { best = placed.slice(); return true; }
      for (const c of opts[i]) { if ((c.isShort && !allowShort) || !free(c, placed)) continue; placed.push(c); if (solve(i + 1, placed, allowShort, allowDrop)) return true; placed.pop(); }
      if (allowDrop) { placed.push({ ...order[i], dropped: true }); if (solve(i + 1, placed, allowShort, allowDrop)) return true; placed.pop(); }
      return false;
    };
    for (const [sh, dr] of [[false, false], [true, false], [true, true]]) { steps = 0; if (solve(0, [], sh, dr)) break; }
    const placed = (best || []).filter((p) => !p.dropped), dropped = (best || order.map((it) => ({ ...it, dropped: true }))).filter((p) => p.dropped);
    return { placed, dropped, rows: placed.length ? Math.max(...placed.map((p) => p.row)) + 1 : 0 };
  }
  function prepNotes(s, annotations = [], x, w, extra = []) {
    const items = [];
    for (const a of annotations || []) {
      if (a.from != null) items.push({ span: true, x0: Math.min(x(a.from), x(a.to)), x1: Math.max(x(a.from), x(a.to)), label: a.label, short: a.short, colour: a.colour });
      else if (a.at != null) items.push({ x: x(a.at), at: a.at, leader: x(a.at), label: a.label, short: a.short, colour: a.colour });
    }
    items.push(...extra);
    return { items, ...lane(s, items.filter((it) => it.label), w) };
  }
  // shaded spans go under the data; marker lines and the label rows over it
  function notesUnder(g, el, N, { padT, h, padB }) {
    const ink = css(el, '--axis-ink', '#6b6b6b'), op = cssNum(el, '--chart-span', 0.07);
    for (const it of N.items) if (it.span) svg('rect', { x: it.x0, y: padT, width: it.x1 - it.x0, height: h - padT - padB, fill: ink, opacity: op }, g);
  }
  function notesOver(g, el, N, { padT, h, padB }) {
    const ink = css(el, '--axis-ink', '#6b6b6b');
    // a marker line runs to the plot's foot, or stops above the bar it points at (it.end)
    for (const it of N.items) if (it.leader != null && !it.drawn) svg('line', { x1: it.leader, x2: it.leader, y1: padT, y2: Math.max(padT, it.end ?? h - padB), stroke: ink, 'stroke-width': 1, opacity: 0.45, 'shape-rendering': 'crispEdges' }, g);
    for (const p of N.placed) {
      const base = padT - 9 - p.row * ROW;
      if (p.leader != null) svg('line', { x1: p.leader, x2: p.leader, y1: base - 8, y2: padT, stroke: ink, 'stroke-width': 1, opacity: 0.45, 'shape-rendering': 'crispEdges' }, g);
      if (p.glyph) svg('path', { d: p.glyph === 'up' ? `M${p.x0} ${base - 1}l3 -6l3 6z` : `M${p.x0} ${base - 7}l3 6l3 -6z`, fill: ink }, g);
      text(g, p.text, { x: p.x0 + (p.glyph ? 9 : 0), y: base, 'font-size': 11, fill: p.colour || ink });
    }
    const el2 = g.ownerSVGElement.parentNode; el2._warned = el2._warned || new Set();
    for (const d of N.dropped) {
      if (d.leader != null) { const hit = svg('line', { x1: d.leader, x2: d.leader, y1: padT, y2: h - padB, stroke: 'transparent', 'stroke-width': 8 }, g); titled(hit, d.label, {}); }
      if (!el2._warned.has(d.label)) { el2._warned.add(d.label); console.warn(`Charts: no room above the plot for "${d.label}". Give it a short form (short) or label fewer markers.`); }
    }
  }
  // does a label box touch a drawn line? polylines are [[x, y], …]; a box is { x0, x1, y0, y1 }
  function hits(b, lines) {
    for (const pts of lines) for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], c = pts[k]; if (!a || !c) continue;
      if (a[0] === c[0]) { if (a[0] >= b.x0 - 3 && a[0] <= b.x1 + 3 && Math.max(a[1], c[1]) >= b.y0 - 3 && Math.min(a[1], c[1]) <= b.y1 + 3) return true; continue; }
      const lo = Math.max(b.x0 - 3, Math.min(a[0], c[0])), hi = Math.min(b.x1 + 3, Math.max(a[0], c[0]));
      for (let xx = lo; xx <= hi; xx += 2) { const yy = a[1] + ((xx - a[0]) / (c[0] - a[0])) * (c[1] - a[1]); if (yy >= b.y0 - 3 && yy <= b.y1 + 3) return true; }
    }
    return false;
  }
  const boxHits = (b, boxes) => boxes.some((r) => b.x0 < r.x1 + 3 && b.x1 > r.x0 - 3 && b.y0 < r.y1 + 3 && b.y1 > r.y0 - 3);
  // a reference line (a budget, an SLO) with its label at an end where no series passes
  function references(g, el, refs, { y, padL, w, lines = [], boxes = [] }) {
    const ink = css(el, '--axis-ink', '#6b6b6b'), s = g.ownerSVGElement;
    for (const r of [].concat(refs || [])) {
      const yy = y(r.value);
      svg('line', { x1: padL, x2: w, y1: yy, y2: yy, stroke: ink, 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.7 }, g);
      if (!r.label) continue;
      const tw = measure(s, r.label, 11), right = r.at !== 'left';
      const cand = [[right, -5], [right, 13], [!right, -5], [!right, 13]].map(([rt, dy]) => ({ x0: rt ? w - tw : padL + 4, x1: rt ? w : padL + 4 + tw, y0: yy + dy - 9, y1: yy + dy + 2, base: yy + dy }));
      const b = cand.find((c) => !hits(c, lines) && !boxHits(c, boxes)) || cand[0];
      text(g, r.label, { x: b.x0, y: b.base, 'font-size': 11, fill: ink });
    }
  }
  // One style object per kind of mark draws both the mark and its legend swatch, so the two cannot drift apart.
  function legendEl(items, target) {
    // Telinha: o CSS da legenda está em style.css (um <style> inline seria bloqueado pelo CSP)
    const ul = document.createElement('ul'); ul.className = 'chart-legend';
    for (const it of items) {
      const li = document.createElement('li'), sw = svg('svg', { width: it.w || 14, height: 12, 'aria-hidden': 'true' });
      it.draw(sw); li.append(sw, document.createTextNode(it.label)); ul.appendChild(li);
    }
    const t = typeof target === 'string' ? document.querySelector(target) : target;
    if (t) t.replaceChildren(ul);
    return ul;
  }
  // charts are laid out with measured text: draw again once the page's fonts have arrived
  function settle(draw) { if (document.fonts) { document.fonts.ready.then(draw); document.fonts.addEventListener?.('loadingdone', draw, { once: true }); } }
  const heightOf = (h) => (typeof h === 'function' ? h() : h);

  function line(el, { labels, series, format = fmt.int, tickFormat = null, height = 220, fill = false, min, max, step = false, annotations, reference, today = null, todayLabel = 'Today', endLabel = false, yTicks = null, xAt = null, legend = null }) {
    el._fmt = format;
    const colourOf = (sr, k) => sr.colour || (k === 0 ? css(el, '--chart-1', '#2f6fdf') : css(el, `--chart-${k + 1}`, css(el, '--chart-muted', '#a3a3a3')));
    const draw = () => {
      const { s, w, h } = frame(el, heightOf(height));
      const all = series.flatMap((x) => x.values.filter((v) => v != null)).concat([].concat(reference || []).map((r) => r.value));
      // max caps the range (a flat series with one spike): values above it are clipped and their peak labelled
      const top = max ?? Math.max(...all);
      const yt = yTicks || ticks(min ?? Math.min(0, ...all), top, 4);
      const tick = tickFormat || format;
      const lastVal = series[0].values.filter((v) => v != null).at(-1);
      const padL = 12 + Math.max(...yt.map((v) => measure(s, tick(v), 12))), padB = 26, padR = endLabel ? 10 + measure(s, format(lastVal), 12, 600) : 0;
      const x = (i) => padL + (i * (w - padL - padR)) / Math.max(1, labels.length - 1);
      // the peaks clipped by max are labelled in the rows above the plot, where the line leaves it
      const peaks = [];
      series.forEach((sr, k) => sr.values.forEach((v, i) => { if (v != null && v > yt.at(-1) && (i === 0 || sr.values[i - 1] == null || sr.values[i - 1] <= yt.at(-1))) { let j = i, peak = v; while (j < sr.values.length && sr.values[j] != null && sr.values[j] > yt.at(-1)) { peak = Math.max(peak, sr.values[j]); j++; } peaks.push({ x: x(i), label: format(peak) + ' at ' + labels[i], colour: colourOf(sr, k) }); } }));
      const scale = (N) => { const padT = LANE(N.rows); return { padT, y: (v) => padT + (h - padT - padB) * (1 - (v - yt[0]) / (yt.at(-1) - yt[0])) }; };
      const linesAt = (y) => series.map((sr) => { const out = []; sr.values.forEach((v, i) => { if (v == null) { out.push(null); return; } const p = [x(i), y(Math.min(v, yt.at(-1)))]; const prev = out.at(-1); if (step && prev) out.push([p[0], prev[1]]); out.push(p); }); return out; }).concat([].concat(reference || []).map((r) => [[padL, y(r.value)], [w, y(r.value)]]));
      let N = prepNotes(s, annotations, x, w, peaks), { padT, y } = scale(N), todayBox = null;
      // the today label goes inside the plot on whichever side of its line no series crosses; failing that, above
      if (today != null && todayLabel) {
        const cut = x(today), tw = measure(s, todayLabel, 11), lines = linesAt(y);
        const cand = [[cut + 4, h - padB - 6], [cut - 4 - tw, h - padB - 6], [cut + 4, padT + 11], [cut - 4 - tw, padT + 11]].map(([x0, b]) => ({ x0, x1: x0 + tw, y0: b - 9, y1: b + 2, base: b }));
        todayBox = cand.find((b) => b.x0 >= padL && b.x1 <= w && !hits(b, lines)) || null;
        if (!todayBox) { N = prepNotes(s, annotations, x, w, [...peaks, { x: cut, leader: cut, drawn: true, label: todayLabel }]); ({ padT, y } = scale(N)); }
      }
      const g = svg('g', {}, s);
      axes(g, el, { w, h, padL, padB, yt, y, labels, x, at: xAt, tick });
      notesUnder(g, el, N, { padT, h, padB });
      series.forEach((sr, k) => {
        const col = colourOf(sr, k);
        const pts = sr.values.map((v, i) => (v == null ? null : [x(i), y(Math.min(v, yt.at(-1)))]));
        // step: a balance that only changes on given days holds its value until the next one
        const d = pts.reduce((acc, p, i) => (p ? acc + (acc && pts[i - 1] ? (step ? `L${p[0].toFixed(1)} ${pts[i - 1][1].toFixed(1)}L` : 'L') : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) : acc), '');
        if (fill && k === 0) { const first = pts.find(Boolean), last = [...pts].reverse().find(Boolean); svg('path', { d: `${d}L${last[0]} ${y(yt[0])}L${first[0]} ${y(yt[0])}Z`, fill: col, opacity: 0.12 }, g); }
        if (today == null) svg('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
        else {
          // a forecast: the line after today is dashed, so a projection never reads as a fact
          const cut = x(today), id = 'c' + k + Math.random().toString(36).slice(2, 8);
          const defs = svg('defs', {}, g);
          const a = svg('clipPath', { id: id + 'a' }, defs); svg('rect', { x: 0, y: 0, width: cut, height: h }, a);
          const b = svg('clipPath', { id: id + 'b' }, defs); svg('rect', { x: cut, y: 0, width: w, height: h }, b);
          svg('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'clip-path': 'url(#' + id + 'a)' }, g);
          svg('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-dasharray': '5 4', opacity: 0.8, 'clip-path': 'url(#' + id + 'b)' }, g);
          if (k === 0) { svg('line', { x1: cut, x2: cut, y1: padT, y2: h - padB, stroke: css(el, '--axis-ink', '#6b6b6b'), 'stroke-width': 1, opacity: 0.4 }, g); if (todayBox) text(g, todayLabel, { x: todayBox.x0, y: todayBox.base, 'font-size': 11, fill: css(el, '--axis-ink', '#6b6b6b') }); }
        }
        if (endLabel && k === 0) { const li = sr.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).at(-1); text(g, format(sr.values[li]), { x: x(li) + 6, y: y(Math.min(sr.values[li], yt.at(-1))) + 4, 'font-size': 12, 'font-weight': 600, fill: css(el, '--ink', '#111') }); }
      });
      references(g, el, reference, { y, padL, w, lines: linesAt(y).slice(0, series.length) });
      notesOver(g, el, N, { padT, h, padB });
      // hover: a rule, a dot per series and a bare tooltip
      const tip = tooltip(el), rule = svg('line', { y1: padT, y2: h - padB, stroke: css(el, '--axis-ink', '#6b6b6b'), 'stroke-width': 1, opacity: 0 }, g);
      const dots = series.map((sr, k) => svg('circle', { r: 3.5, fill: css(el, '--surface', '#fff'), stroke: colourOf(sr, k), 'stroke-width': 2, opacity: 0 }, g));
      const hit = svg('rect', { x: padL, y: padT, width: w - padL, height: h - padT - padB, fill: 'transparent' }, s);
      const move = (ev) => { const r = s.getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * w; const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - padL) / (w - padL - padR)) * (labels.length - 1)))); rule.setAttribute('x1', x(i)); rule.setAttribute('x2', x(i)); rule.setAttribute('opacity', 0.35); series.forEach((sr, k) => { const v = sr.values[i]; dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', v == null ? -99 : y(Math.min(v, yt.at(-1)))); dots[k].setAttribute('opacity', v == null ? 0 : 1); }); tip.innerHTML = `<div style="opacity:.7">${labels[i]}</div>` + series.map((sr) => `<div><b style="font-weight:600">${sr.values[i] == null ? '–' : format(sr.values[i])}</b> ${series.length > 1 ? sr.name : ''}</div>`).join(''); const left = Math.min((x(i) / w) * r.width + 12, r.width - tip.offsetWidth - 4); tip.style.left = `${Math.max(0, left)}px`; tip.style.top = '0px'; tip.style.opacity = 1; };
      hit.addEventListener('pointermove', move); hit.addEventListener('pointerleave', () => { tip.style.opacity = 0; rule.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); });
      const last = series[0].values.filter((v) => v != null).at(-1);
      s.setAttribute('aria-label', `${series.map((x) => x.name).join(', ')}, ${labels[0]} to ${labels.at(-1)}; latest ${last == null ? 'no data' : format(last)}`);
    };
    draw(); watch(el, draw); settle(draw);
    const lg = series.length > 1 ? legendEl(series.map((sr, k) => ({ label: sr.name, w: 16, draw: (sw) => svg('line', { x1: 0, x2: 16, y1: 6, y2: 6, stroke: colourOf(sr, k), 'stroke-width': 2, 'stroke-dasharray': sr.dash ? '4 3' : null }, sw) })), legend) : null;
    return { legend: lg };
  }
  function watch(el, draw) { if (!('ResizeObserver' in window)) return; let w = el.clientWidth; new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) > 4) { w = el.clientWidth; draw(); } }).observe(el); }
  window.Charts = { line, ticks, fmt };
})();
