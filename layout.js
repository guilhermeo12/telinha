/* Telinha · layout ajustável: barra lateral e painel recolhíveis, cartões que se arrastam entre lugares.
   Transmitir: Espectadores e Chat. Assistir: Chat. Lugares: no painel, embaixo do vídeo ou à direita dele.
   Cada mudança anima (FLIP: mede antes, move no DOM, anima da posição antiga até a nova). Nos temas de vidro
   o cartão arrastado se comporta como uma gota: estica na direção do movimento e assenta com um quique. */
'use strict';

const Layout = (() => {
  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);
  const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const isGlass = () => (root.dataset.theme || '').startsWith('vidro');
  const desktop = () => matchMedia('(min-width: 761px)').matches;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Mola: com quique nos vidros, sem quique nos outros temas
  const SPRING = 'linear(0, 0.013 0.6%, 0.05 1.2%, 0.207 2.6%, 0.85 7.3%, 1.012 9.2%, 1.113 11.2%, 1.15 12.8%, 1.159 14.2%, 1.141 16.2%, 1.075 20%, 1.012 24.3%, 0.985 27.6%, 0.977 30.6%, 0.983 35.5%, 1.002 44.5%, 1.004 52.8%, 1)';
  const SMOOTH = 'cubic-bezier(.2, .8, .2, 1)';
  const ease = () => (isGlass() ? SPRING : SMOOTH);
  const duration = () => (reduced() ? 0 : isGlass() ? 620 : 340);

  // ---------------------------------------------------------------- FLIP
  // Mede os elementos, roda a mudança e anima cada um da posição antiga até a nova
  function flip(elements, change) {
    const before = new Map(elements.map((el) => [el, el.getBoundingClientRect()]));
    change();
    if (!duration()) return;
    for (const [el, a] of before) {
      if (!el.isConnected) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: duration(), easing: ease() });
    }
  }

  // ---------------------------------------------------------------- barra lateral
  const navToggle = byId('navToggle');
  function setNav(mini) {
    root.classList.add('layoutAnim');
    if (mini) root.dataset.nav = 'mini';
    else delete root.dataset.nav;
    navToggle.setAttribute('aria-expanded', String(!mini));
    navToggle.title = mini ? 'Mostrar a barra lateral' : 'Recolher a barra lateral';
    navToggle.setAttribute('aria-label', navToggle.title);
    save('telinha.nav', mini ? 'mini' : 'full');
    clearTimeout(setNav.t);
    setNav.t = setTimeout(() => { root.classList.remove('layoutAnim'); if (typeof Theme !== 'undefined') Theme.placeIndicator(); }, 700);
  }
  navToggle.addEventListener('click', () => setNav(root.dataset.nav !== 'mini'));
  navToggle.setAttribute('aria-expanded', String(root.dataset.nav !== 'mini'));
  if (root.dataset.nav === 'mini') navToggle.title = 'Mostrar a barra lateral';

  // ---------------------------------------------------------------- painel de Transmitir e Assistir
  function setPanel(view, mini) {
    root.classList.add('layoutAnim');
    view.classList.toggle('panelMini', mini);
    save(`telinha.panel.${view.id}`, mini ? 'mini' : 'full');
    clearTimeout(setPanel.t);
    setPanel.t = setTimeout(() => root.classList.remove('layoutAnim'), 700);
  }
  for (const view of [byId('host'), byId('watch')]) {
    if (load(`telinha.panel.${view.id}`) === 'mini') view.classList.add('panelMini');
    for (const b of view.querySelectorAll('[data-panel-toggle]')) {
      b.addEventListener('click', () => setPanel(view, !view.classList.contains('panelMini')));
    }
  }

  // ---------------------------------------------------------------- onde cada cartão fica
  const zonesOf = (view) => [...view.querySelectorAll('.dockZone')];
  const zone = (view, name) => view.querySelector(`.dockZone[data-zone="${name}"]`);

  function saveDocks(view) {
    const out = {};
    for (const z of zonesOf(view)) z.querySelectorAll(':scope > .dock').forEach((d, i) => { out[d.dataset.dock] = [z.dataset.zone, i]; });
    save(`telinha.dock.${view.id}`, JSON.stringify(out));
  }

  // Lugar padrão (quem nunca arrumou): chat na coluna da direita, câmera e voz embaixo do vídeo.
  // No celular fica como no HTML (tudo embaixo do vídeo, no painel)
  const HOME = [['viewers', 'below'], ['voice', 'below'], ['chat', 'right']];
  function defaults(view) {
    if (!desktop()) return;
    for (const [name, z] of HOME) {
      const d = view.querySelector(`.dock[data-dock="${name}"]`);
      if (d) zone(view, z).append(d);
    }
  }

  function restoreDocks(view) {
    let saved;
    try { saved = JSON.parse(load(`telinha.dock.${view.id}`) || 'null'); } catch {}
    if (!saved) return defaults(view);
    const docks = [...view.querySelectorAll('.dock')].filter((d) => saved[d.dataset.dock]);
    docks.sort((a, b) => saved[a.dataset.dock][1] - saved[b.dataset.dock][1]);
    for (const d of docks) zone(view, saved[d.dataset.dock][0])?.append(d);
  }

  // ---------------------------------------------------------------- minimizar cartões
  // O "–" no título minimiza. Se ainda há um cartão aberto no mesmo lugar, o minimizado vira só a barra do
  // título (o espaço já é da coluna). Se todos do lugar estão minimizados, viram ícones: à direita, uma coluna
  // fina; embaixo do vídeo, botões pequenos; e o vídeo ganha o espaço. O chat minimizado conta as mensagens novas.
  const ICON = {
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    voice: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    viewers: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.4a6.5 6.5 0 0 1 3.5 5.6"/>',
  };
  const minKey = (d) => `telinha.min.${d.closest('.view').id}.${d.dataset.dock}`;
  function zonesMin(view) {
    for (const z of zonesOf(view)) {
      const docks = [...z.querySelectorAll(':scope > .dock')];
      z.classList.toggle('allMin', z.dataset.zone !== 'panel' && docks.length > 0 && docks.every((d) => d.classList.contains('min')));
    }
  }
  function badge(d, n) {
    d.dataset.unread = String(n);
    for (const b of d.querySelectorAll('.dockBadge')) b.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
  }
  // Hora da mensagem mais nova na lista (o chat redesenha a lista inteira a cada mensagem e corta as antigas)
  const newest = (list) => Math.max(0, ...[...list.children].map((li) => Number(li.dataset.ts) || 0));
  function setMin(d, on) {
    const view = d.closest('.view');
    const list = d.querySelector('.chatList');
    if (on && list) d.dataset.seen = String(newest(list));
    flip([...view.querySelectorAll('.dock, .videoWrap')], () => {
      d.classList.toggle('min', on);
      zonesMin(view);
    });
    save(minKey(d), on ? '1' : '');
    if (!on) badge(d, 0);
    const b = d.querySelector('.dockMin');
    b.title = on ? 'Abrir' : 'Minimizar';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-expanded', String(!on));
  }
  for (const d of document.querySelectorAll('.dock')) {
    const head = d.querySelector('.dockHandle');
    const name = head.querySelector('h2, h3');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'iconBtn dockMin';
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/><path class="plus" d="M12 6v12"/></svg>';
    b.addEventListener('click', () => setMin(d, !d.classList.contains('min')));
    const count = document.createElement('span');
    count.className = 'dockBadge';
    name.after(count, b);
    // O ícone (quando todos do lugar estão minimizados): clicar abre o cartão
    const icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'dockIcon';
    icon.title = `Abrir: ${name.childNodes[0]?.textContent.trim() || ''}`;
    icon.setAttribute('aria-label', icon.title);
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[d.dataset.dock] || ''}</svg><span class="dockBadge"></span>`;
    icon.addEventListener('click', () => setMin(d, false));
    d.prepend(icon);
    // Mensagem nova com o chat minimizado: soma no contador
    const list = d.querySelector('.chatList');
    if (list) {
      new MutationObserver(() => {
        if (!d.classList.contains('min')) return;
        const seen = Number(d.dataset.seen || 0);
        badge(d, [...list.children].filter((li) => Number(li.dataset.ts) > seen).length);
      }).observe(list, { childList: true });
    }
    if (load(minKey(d)) === '1') setMin(d, true);
    else setMin(d, false);
  }

  // ---------------------------------------------------------------- arrastar
  let drag = null;

  // Onde soltar: a zona sob o ponteiro. Zona vazia ganha uma área de alvo (o tracejado que aparece no arraste).
  function targetRect(z) {
    const r = z.getBoundingClientRect();
    // O lugar vazio do painel tem caixa durante o arraste; os outros vazios não (a coluna da direita tem largura 0)
    if (z.children.length || (z.dataset.zone === 'panel' && r.height > 20)) {
      // O painel inteiro aceita (ele rola, e os cartões dele podem estar fora da vista)
      if (z.dataset.zone === 'panel') {
        const p = z.closest('.panel').getBoundingClientRect();
        return { left: p.left - 24, right: p.right + 24, top: p.top, bottom: p.bottom };
      }
      return { left: r.left - 24, right: r.right + 24, top: r.top - 24, bottom: r.bottom + 24 };
    }
    // Vazia (display: contents, sem caixa): o alvo é a faixa onde aparece o "Soltar aqui"
    const p = z.parentElement.getBoundingClientRect();
    if (z.dataset.zone === 'right') return { left: p.right - 160, right: p.right, top: p.top, bottom: p.bottom };
    return { left: p.left, right: p.right, top: p.bottom - 150, bottom: p.bottom };
  }

  function pick(x, y) {
    for (const z of zonesOf(drag.view)) {
      const r = targetRect(z);
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        // Posição dentro da zona: antes do primeiro cartão cujo meio está abaixo do ponteiro
        const items = [...z.children].filter((c) => c !== drag.ghost);
        const before = items.find((c) => { const b = c.getBoundingClientRect(); return y < b.top + b.height / 2; }) || null;
        return { z, before };
      }
    }
    return null;
  }

  function moveGhost(t) {
    const { ghost } = drag;
    if (ghost.parentElement === t.z && ghost.nextElementSibling === t.before) return;
    // Os vizinhos e o vídeo abrem espaço deslizando, não pulando
    const affected = [...drag.view.querySelectorAll('.dock, .videoWrap')].filter((el) => el !== drag.card);
    flip(affected, () => t.z.insertBefore(ghost, t.before));
    for (const z of zonesOf(drag.view)) z.classList.toggle('dropTarget', z === t.z);
  }

  function start(e, card) {
    // O lugar do painel (vazio, só existe durante o arraste) fica no fim do painel, que rola até lá
    root.classList.add('docking');
    const view = card.closest('.view');
    const panelZone = view.querySelector('.panel > .dockZone');
    if (panelZone && card.parentElement !== panelZone && !view.classList.contains('panelMini')) panelZone.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const r = card.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'dockGhost';
    ghost.style.height = `${r.height}px`;
    card.before(ghost);
    drag = {
      card, view, ghost, id: e.pointerId,
      ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, h: r.height,
      x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: performance.now(), raf: 0,
    };
    card.classList.add('dragging');
    card.style.cssText = `position: fixed; left: 0; top: 0; width: ${r.width}px; margin: 0; z-index: 60;`;
    // Cartão largo encolhe enquanto voa (a gota se solta do lugar); o ponteiro fica no mesmo ponto do título
    const w = Math.min(r.width, 380);
    if (w < r.width) {
      drag.ox *= w / r.width;
      card.offsetWidth;
      card.style.width = `${w}px`;
    }
    paint();
    card.animate([{ scale: 1 }, { scale: isGlass() ? 1.04 : 1.02 }], { duration: 220, easing: SMOOTH, fill: 'forwards' });
  }

  // O cartão segue o ponteiro; nos vidros estica na direção do movimento (a gota) e inclina um pouco
  function paint() {
    if (!drag) return;
    const { card, x, y, ox, oy, vx, vy } = drag;
    let shape = '';
    if (isGlass() && !reduced()) {
      const sx = Math.min(Math.abs(vx) * 0.06, 0.12), sy = Math.min(Math.abs(vy) * 0.06, 0.12);
      const rot = Math.max(-4, Math.min(4, vx * 0.35));
      shape = ` rotate(${rot}deg) scale(${1 + sx - sy * 0.5}, ${1 + sy - sx * 0.5})`;
    }
    card.style.transform = `translate(${x - ox}px, ${y - oy}px)${shape}`;
  }

  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now();
    const dt = Math.max(now - drag.t, 1);
    // Velocidade suavizada (px/ms), para a gota não tremer
    drag.vx = drag.vx * 0.7 + ((e.clientX - drag.x) / dt) * 0.3;
    drag.vy = drag.vy * 0.7 + ((e.clientY - drag.y) / dt) * 0.3;
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    cancelAnimationFrame(drag.raf);
    drag.raf = requestAnimationFrame(paint);
    const t = pick(e.clientX, e.clientY);
    if (t) moveGhost(t);
    else for (const z of zonesOf(drag.view)) z.classList.remove('dropTarget');
  }

  // Soltar: o cartão voa até o lugar do fantasma e assenta (com quique nos vidros)
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { card, ghost, view } = drag;
    cancelAnimationFrame(drag.raf);
    drag = null;
    const from = card.getBoundingClientRect();
    card.getAnimations().forEach((a) => a.cancel());
    card.style.cssText = '';
    card.classList.remove('dragging');
    ghost.replaceWith(card);
    root.classList.remove('docking');
    for (const z of zonesOf(view)) z.classList.remove('dropTarget');
    saveDocks(view);
    zonesMin(view);
    const to = card.getBoundingClientRect();
    if (!duration()) return;
    const dx = from.left - to.left, dy = from.top - to.top;
    const sx = from.width / to.width, sy = from.height / to.height;
    const frames = [
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' },
    ];
    card.animate(frames, { duration: duration(), easing: ease() });
    if (isGlass()) {
      // Ao assentar, a gota achata e volta (o "toque" no lugar)
      card.animate([{ scale: '1 1' }, { scale: '1.025 0.97' }, { scale: '0.99 1.012' }, { scale: '1 1' }],
        { duration: 520, delay: duration() * 0.55, easing: 'ease-out' });
    }
  }

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.dockHandle');
    if (!handle || e.button !== 0 || !desktop() || e.target.closest('button, a, input, select')) return;
    const card = handle.closest('.dock');
    const sx = e.clientX, sy = e.clientY;
    // Só começa a arrastar depois de 5px, para não roubar cliques e seleção de texto
    const wait = (ev) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      cleanup();
      start(e, card);
      move(ev);
    };
    const cleanup = () => { removeEventListener('pointermove', wait); removeEventListener('pointerup', cleanup); };
    addEventListener('pointermove', wait);
    addEventListener('pointerup', cleanup);
  });
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);

  // Volta tudo ao padrão (botão nas Configurações)
  function reset() {
    for (const view of [byId('host'), byId('watch')]) {
      const docks = [...view.querySelectorAll('.dock')];
      flip([...docks, view.querySelector('.videoWrap')], () => defaults(view));
      view.classList.remove('panelMini');
      for (const d of docks) if (d.classList.contains('min')) setMin(d, false);
      save(`telinha.dock.${view.id}`, '');
      save(`telinha.panel.${view.id}`, 'full');
    }
    if (root.dataset.nav === 'mini') setNav(false);
  }
  byId('resetLayout')?.addEventListener('click', reset);

  restoreDocks(byId('host'));
  restoreDocks(byId('watch'));
  zonesMin(byId('host'));
  zonesMin(byId('watch'));
  return { setNav, setPanel, reset, flip, setMin };
})();
