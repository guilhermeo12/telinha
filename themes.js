/* Telinha · temas: escolha, indicador da navegação e os efeitos dos temas de vidro. */
'use strict';

const THEMES = [
  { id: 'preto', name: 'Preto', desc: 'OLED: preto puro, elevação só por luz. O mais silencioso, para a noite.' },
  { id: 'vidro', name: 'Vidro', desc: 'Liquid glass completo: o fundo é a transmissão, com lente nos controles e sobre o vídeo. Pesa mais.' },
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
  darkQuery.addEventListener('change', GlassTint.apply);
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
    const tint = GlassTint.blobs();
    const blobs = [
      [tint.hues[0], 8 + Math.sin(t) * 4.5, 3.5 + Math.cos(t * 0.8) * 2],
      [tint.hues[1], 3.5 + Math.cos(t * 0.7) * 4, 6 + Math.sin(t * 1.1) * 2],
      [tint.hues[2], 12.5 + Math.sin(t * 0.9) * 3, 6.5 + Math.cos(t * 0.6) * 1.5],
    ];
    for (const [hue, x, y] of blobs) {
      const g = actx.createRadialGradient(x * sx, y * sy, 0, x * sx, y * sy, 6.5 * sx);
      g.addColorStop(0, `hsla(${hue}, ${tint.sat}%, ${tint.light}%, .9)`);
      g.addColorStop(1, `hsla(${hue}, ${tint.sat}%, ${tint.light}%, 0)`);
      actx.fillStyle = g;
      actx.fillRect(0, 0, AW, AH);
    }
  }

  function ambientTick(dt) {
    if (document.hidden) return;
    const v = liveVideo();
    // Acrílico sem vídeo: quem pinta o fundo é o Windows, e o canvas sai da frente
    if (root.classList.contains('acrylic')) {
      root.classList.toggle('glassVideo', !!v);
      if (!v) return;
    }
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

  // ---------------------------------------------------------------- vidro: acrílico, o fundo é o que está atrás da janela
  // Opção dos temas de vidro. Com "reduzir transparência" fica desligado; o véu com a cor do vidro vem de GlassTint
  const noTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const wantAcrylic = () => isGlass() && load('telinha.glassAcrylic') === '1' && root.dataset.reduceTransparency !== '1' && !noTransparency.matches;
  async function syncAcrylic() {
    const want = wantAcrylic();
    const ok = await window.telinha.windowMaterial?.(want);
    root.classList.toggle('acrylic', !!ok && wantAcrylic());
    // Windows sem acrílico (só existe no site quando ok é undefined): a opção volta a ficar desligada
    if (want && ok === false) {
      save('telinha.glassAcrylic', '0');
      byId('glassAcrylic').checked = false;
      byId('glassTransparencyRow').classList.add('hidden');
      toast('O acrílico precisa do Windows 11 22H2 ou mais novo.', true);
    }
  }
  noTransparency.addEventListener('change', syncAcrylic);

  // ---------------------------------------------------------------- aplicar e escolher
  function apply(id) {
    if (!THEMES.some((t) => t.id === id)) id = 'preto';
    root.dataset.theme = id;
    save('telinha.theme', id);
    setAmbient(id === 'vidro' ? 'full' : id === 'vidro-lite' ? 'lite' : null);
    syncAcrylic();
    window.GlassLens?.set(id === 'vidro');
    GlassTint.apply();
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
      card.title = t.desc; // a descrição aparece cortada em duas linhas
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

  // Cor do vidro: seletor do sistema, caixa de hex e atalhos; a mudança aparece na hora e fica salva neste aparelho
  const tintPick = byId('tintPick'), tintHex = byId('tintHex');
  function showTint(hex) {
    tintPick.value = hex;
    tintHex.value = hex.toUpperCase();
    tintHex.removeAttribute('aria-invalid');
    for (const b of byId('tintPresets').children) b.setAttribute('aria-pressed', String(b.dataset.tint === hex));
  }
  function setTint(hex) {
    save('telinha.glassTint', hex);
    GlassTint.apply();
    showTint(hex);
  }
  for (const [name, hex] of [['Grafite', GlassTint.DEFAULT], ['Âmbar', '#ff9a4d'], ['Violeta', '#a56bff'], ['Azul', '#3b82f6']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tintDot';
    b.dataset.tint = hex;
    b.title = name;
    b.setAttribute('aria-label', name);
    b.style.backgroundColor = hex;
    b.addEventListener('click', () => setTint(hex));
    byId('tintPresets').append(b);
  }
  tintPick.addEventListener('input', () => setTint(tintPick.value));
  tintHex.addEventListener('input', () => {
    const hex = GlassTint.parse(tintHex.value);
    if (hex) {
      save('telinha.glassTint', hex);
      GlassTint.apply();
      tintPick.value = hex;
      tintHex.removeAttribute('aria-invalid');
    } else tintHex.setAttribute('aria-invalid', 'true');
  });
  tintHex.addEventListener('change', () => showTint(GlassTint.current())); // ao sair da caixa, mostra a cor que valeu
  byId('tintReset').addEventListener('click', () => setTint(GlassTint.DEFAULT));
  showTint(GlassTint.current());

  const reduce = byId('reduceTransparency');
  reduce.checked = root.dataset.reduceTransparency === '1';
  reduce.addEventListener('change', () => {
    if (reduce.checked) root.dataset.reduceTransparency = '1';
    else delete root.dataset.reduceTransparency;
    save('telinha.reduceTransparency', reduce.checked ? '1' : '0');
    syncAcrylic();
  });

  const acrylicBox = byId('glassAcrylic'), clear = byId('glassTransparency');
  function showAcrylic() {
    acrylicBox.checked = load('telinha.glassAcrylic') === '1';
    byId('glassTransparencyRow').classList.toggle('hidden', !acrylicBox.checked);
    clear.value = GlassTint.transparency();
    byId('glassTransparencyLabel').textContent = `${clear.value}%`;
  }
  acrylicBox.addEventListener('change', () => {
    save('telinha.glassAcrylic', acrylicBox.checked ? '1' : '0');
    showAcrylic();
    syncAcrylic();
  });
  clear.addEventListener('input', () => {
    save('telinha.glassTransparency', clear.value);
    showAcrylic();
    GlassTint.apply();
  });
  showAcrylic();

  // Sub-abas das Configurações: um assunto por vez
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('[data-settings-tab]')) {
        t.classList.toggle('primary', t === tab);
        t.setAttribute('aria-pressed', String(t === tab));
      }
      for (const pane of document.querySelectorAll('[data-settings-pane]')) pane.classList.toggle('hidden', pane.dataset.settingsPane !== tab.dataset.settingsTab);
      byId('themes').scrollTop = 0;
    });
  }

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
