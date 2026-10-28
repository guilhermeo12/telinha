/* Telinha · temas: escolha, indicador da navegação e os efeitos dos temas de vidro. */
'use strict';

const THEMES = [
  { id: 'preto', name: 'Preto', desc: 'OLED: preto puro, elevação só por luz. O mais silencioso, para a noite.' },
  { id: 'vidro', name: 'Vidro', desc: 'Liquid glass completo: o fundo é a transmissão, com lente nos controles. Pesa mais.' },
  { id: 'vidro-lite', name: 'Vidro Lite', desc: 'O mesmo vidro, sem a lente e com um fundo leve. Não derruba o vídeo.' },
  { id: 'terminal', name: 'Estúdio', desc: 'Sala de controle: trilho de ícones, parede de monitores com luz de "no ar".' },
  { id: 'papel', name: 'Programação', desc: 'Guia de TV impresso: quem está no ar vira uma grade de horários.' },
  { id: 'moldura', name: 'Moldura', desc: 'Abas no topo e uma folha branca recortada dentro de um L tingido.' },
  { id: 'pastel', name: 'Pastel', desc: 'Mosaico de ladrilhos: cada seção com sua cor clara, cantos redondos.' },
  { id: 'editorial', name: 'Revista', desc: 'Capa de revista: cabeçalho em serifa, saudação e o amigo ao vivo na capa.' },
];

const Theme = (() => {
  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const current = () => root.dataset.theme || 'preto';
  // Temas claros que também têm versão escura (Configurações › Aparência)
  const LIGHT = ['papel', 'moldura', 'pastel', 'editorial'];
  const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  function applyMode() {
    const mode = load('telinha.mode') || 'light';
    root.dataset.mode = mode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : mode;
    requestAnimationFrame(() => window.renderHome?.());
  }
  darkQuery.addEventListener('change', applyMode);
  const isGlass = () => current().startsWith('vidro');

  // ---------------------------------------------------------------- indicador da navegação
  // Um elemento só desliza até o item ativo da barra lateral; cada tema decide a forma.
  const nav = document.querySelector('.nav');
  const indicator = document.createElement('span');
  indicator.className = 'navIndicator';
  indicator.setAttribute('aria-hidden', 'true');
  nav.prepend(indicator);
  let lastPos = null;

  function placeIndicator() {
    const item = nav.querySelector('.navItem.active');
    indicator.classList.toggle('hidden', !item);
    if (!item) return;
    // Navegação em coluna (barra lateral) ou em linha (abas no topo: Moldura, Revista)
    const row = getComputedStyle(nav).flexDirection === 'row';
    const pos = row ? item.offsetLeft : item.offsetTop;
    if (row) {
      indicator.style.height = '';
      indicator.style.width = `${item.offsetWidth}px`;
      indicator.style.transform = `translateX(${pos}px)`;
    } else {
      indicator.style.width = '';
      indicator.style.height = `${item.offsetHeight}px`;
      indicator.style.transform = `translateY(${pos}px)`;
    }
    const lastY = lastPos;
    const y = pos;
    lastPos = pos;
    if (lastY !== null && y !== lastY) {
      // Nos vidros a gota estica enquanto viaja
      indicator.classList.add('moving');
      clearTimeout(placeIndicator.t);
      placeIndicator.t = setTimeout(() => indicator.classList.remove('moving'), 220);
    }
  }
  new MutationObserver(placeIndicator).observe(document.querySelector('.sidebar'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', placeIndicator);
  document.fonts?.ready.then(placeIndicator);

  // ---------------------------------------------------------------- vidro: o ambiente
  // O quadro do vídeo que está na tela vai para um canvas pequeno, esticado na janela; cada quadro entra
  // misturado ao anterior, então as cores mudam devagar, como luz refletida.
  // Completo: 64x36; o desfoque é feito no próprio canvas pequeno (barato), não no CSS.
  // Lite: 16x9 sem desfoque; a interpolação ao esticar faz o resto.
  // Quantas vezes por segundo o fundo atualiza é escolha do usuário (15, 30 ou 60), nos dois.
  const ambient = byId('ambient');
  const actx = ambient.getContext('2d', { alpha: false });
  let AW = 16, AH = 9;
  let ambientRaf = 0;
  let ambientMode = null;
  let ambientFps = 30;
  let lastTick = 0;
  const t0 = performance.now();

  function liveVideo() {
    const watchActive = byId('watch').classList.contains('active');
    const order = watchActive ? ['remote', 'preview'] : ['preview', 'remote'];
    for (const id of order) {
      const v = byId(id);
      if (v.srcObject && v.readyState >= 2 && v.videoWidth) return v;
    }
    return null;
  }

  function drawIdle(now) {
    // Sem vídeo: três manchas de cor lentas, para o vidro ter o que refratar
    const t = (now - t0) / 9000;
    const light = matchMedia('(prefers-color-scheme: light)').matches;
    const sx = AW / 16, sy = AH / 9;
    actx.globalAlpha = 1;
    actx.fillStyle = light ? '#dfe3ea' : '#0b0d14';
    actx.fillRect(0, 0, AW, AH);
    const blobs = [
      [210, 8 + Math.sin(t) * 4.5, 3.5 + Math.cos(t * 0.8) * 2],
      [265, 3.5 + Math.cos(t * 0.7) * 4, 6 + Math.sin(t * 1.1) * 2],
      [190, 12.5 + Math.sin(t * 0.9) * 3, 6.5 + Math.cos(t * 0.6) * 1.5],
    ];
    for (const [hue, x, y] of blobs) {
      const g = actx.createRadialGradient(x * sx, y * sy, 0, x * sx, y * sy, 6.5 * sx);
      g.addColorStop(0, `hsla(${hue}, 80%, ${light ? 72 : 42}%, .9)`);
      g.addColorStop(1, `hsla(${hue}, 80%, ${light ? 72 : 42}%, 0)`);
      actx.fillStyle = g;
      actx.fillRect(0, 0, AW, AH);
    }
  }

  function ambientTick(dt) {
    if (document.hidden) return;
    const v = liveVideo();
    if (v) {
      // Mistura com o quadro anterior só o bastante para não piscar. O peso de cada quadro depende do intervalo,
      // então o fundo acompanha o vídeo no mesmo tempo (~60 ms) em qualquer fps.
      const full = ambientMode === 'full';
      actx.globalAlpha = 1 - Math.exp(-dt / 60);
      // Desenha um pouco maior que o canvas, para o desfoque não escurecer as bordas
      actx.filter = full ? 'blur(2px)' : 'none';
      const m = full ? 3 : 0;
      try { actx.drawImage(v, -m, -m, AW + 2 * m, AH + 2 * m); } catch {}
      actx.filter = 'none';
      actx.globalAlpha = 1;
    } else {
      drawIdle(performance.now());
    }
  }

  // Preso ao requestAnimationFrame, para os quadros do fundo caírem junto com os da tela
  function ambientLoop(now) {
    ambientRaf = requestAnimationFrame(ambientLoop);
    const dt = now - lastTick;
    if (dt < 1000 / ambientFps - 4) return;
    lastTick = now;
    ambientTick(Math.min(dt, 250));
  }

  function setAmbient(mode) {
    cancelAnimationFrame(ambientRaf);
    ambientRaf = 0;
    ambientMode = mode;
    if (!mode) return;
    [AW, AH] = mode === 'full' ? [64, 36] : [16, 9];
    ambient.width = AW;
    ambient.height = AH;
    ambientTick(250);
    lastTick = performance.now();
    ambientRaf = requestAnimationFrame(ambientLoop);
  }

  // ---------------------------------------------------------------- vidro: brilho especular
  let lit = null;
  const litSelector = '.card, .panel, .sidebar, .modalBox, .themeCard, .account, .btn:not(.fsBtn)';
  document.addEventListener('pointermove', (e) => {
    if (!isGlass()) return;
    const el = e.target.closest?.(litSelector);
    if (lit && lit !== el) lit.style.setProperty('--lit', '0');
    lit = el;
    if (!el) return;
    el.classList.add('glassLit');
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
    el.style.setProperty('--lit', '1');
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (lit) lit.style.setProperty('--lit', '0'); });

  // ---------------------------------------------------------------- aplicar e escolher
  function apply(id) {
    if (!THEMES.some((t) => t.id === id)) id = 'preto';
    root.dataset.theme = id;
    save('telinha.theme', id);
    setAmbient(id === 'vidro' ? 'full' : id === 'vidro-lite' ? 'lite' : null);
    byId('reduceRow').classList.toggle('hidden', !id.startsWith('vidro'));
    byId('modeRow').classList.toggle('hidden', !LIGHT.includes(id));
    for (const card of document.querySelectorAll('.themeCard')) card.setAttribute('aria-pressed', String(card.dataset.id === id));
    requestAnimationFrame(() => requestAnimationFrame(placeIndicator));
    window.renderHome?.();
  }

  // Cada miniatura usa os tokens do próprio tema (o atributo data-theme vale em qualquer elemento)
  function miniature(id) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.dataset.theme = id;
    sw.innerHTML = `
      <span class="mAmbient"></span>
      <span class="mTop"><i class="mMark"></i><i class="mTab"></i><i class="mTab dim"></i></span>
      <span class="mBody">
        <span class="mPanel"><i class="mLine"></i><i class="mLine short"></i><i class="mBtn"></i></span>
        <span class="mStage"><span class="mVideo"><i class="mLive"></i></span><span class="mCard"><i class="mLine"></i><i class="mLine short"></i></span></span>
      </span>`;
    return sw;
  }

  function renderPicker() {
    const grid = byId('themeGrid');
    grid.innerHTML = '';
    for (const t of THEMES) {
      const card = document.createElement('button');
      card.className = 'themeCard';
      card.dataset.id = t.id;
      card.setAttribute('aria-pressed', String(t.id === current()));
      const info = document.createElement('span');
      info.className = 'info';
      info.innerHTML = '<span class="tname"></span><span class="tdesc"></span>';
      info.querySelector('.tname').textContent = t.name;
      info.querySelector('.tdesc').textContent = t.desc;
      card.append(miniature(t.id), info);
      card.addEventListener('click', () => apply(t.id));
      grid.append(card);
    }
  }

  const fpsSelect = byId('ambientFps');
  try { if (['15', '30', '60'].includes(localStorage.getItem('telinha.ambientFps'))) fpsSelect.value = localStorage.getItem('telinha.ambientFps'); } catch {}
  ambientFps = Number(fpsSelect.value);
  fpsSelect.addEventListener('change', () => {
    ambientFps = Number(fpsSelect.value);
    save('telinha.ambientFps', fpsSelect.value);
  });

  const reduce = byId('reduceTransparency');
  reduce.checked = root.dataset.reduceTransparency === '1';
  reduce.addEventListener('change', () => {
    if (reduce.checked) root.dataset.reduceTransparency = '1';
    else delete root.dataset.reduceTransparency;
    save('telinha.reduceTransparency', reduce.checked ? '1' : '0');
  });

  renderPicker();
  byId('themeMode').value = load('telinha.mode') || 'light';
  byId('themeMode').addEventListener('change', () => {
    save('telinha.mode', byId('themeMode').value);
    applyMode();
  });
  applyMode();
  apply(current());
  return { apply, list: THEMES, placeIndicator };
})();
