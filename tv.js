/* Telinha TV · o site dentro do app de Android TV (tv/). Só o básico, pelo controle remoto: entrar com o Discord
   por QR code, a lista de amigos e assistir. Fora da TV este arquivo não faz nada. */
'use strict';
(() => {
  const root = document.documentElement;
  if (!root.classList.contains('tv')) return;

  const make = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------------------------------------------------------------- tela
  const app = make('div');
  app.id = 'tvApp';
  const head = make('header', 'tvHead');
  const brand = make('b', 'tvBrand', 'Telinha');
  const state = make('span', 'tvState');
  const mine = make('span', 'tvMine');
  head.append(brand, state, mine);

  const login = make('section', 'tvLogin');
  const qrBox = make('canvas', 'tvQr');
  qrBox.width = qrBox.height = 660;
  const steps = make('div', 'tvSteps');
  steps.append(make('h1', null, 'Entre com o Discord'), make('p', null, '1. Aponte a câmera do celular para o código.'), make('p', null, '2. Autorize no Discord.'));
  const confirmLine = make('p');
  steps.append(confirmLine);
  login.append(qrBox, steps);

  const list = make('section', 'tvList');
  const rows = make('div', 'tvRows');
  list.append(make('h1', null, 'Amigos'), rows);

  const foot = make('form', 'tvFoot');
  const codeInput = make('input');
  codeInput.maxLength = 9;
  codeInput.autocomplete = 'off';
  codeInput.placeholder = 'Assistir pelo código, ex.: ABCD-EFGH';
  codeInput.setAttribute('aria-label', 'Código de quem está transmitindo');
  const watchBtn = make('button', 'btn', 'Assistir');
  const qualityBtn = make('button', 'btn', 'Qualidade');
  qualityBtn.type = 'button';
  const logoutBtn = make('button', 'btn', 'Sair da conta');
  logoutBtn.type = 'button';
  foot.append(codeInput, watchBtn, qualityBtn, logoutBtn);
  app.append(head, login, list, foot);
  document.body.append(app);

  foot.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!normalizeCode(codeInput.value)) return toast('Digite o código, ex.: ABCD-EFGH.', true);
    Share.joinInvite(codeInput.value);
    codeInput.value = '';
    return undefined;
  });
  // A TV é de quem estiver na sala: os amigos de uma conta não podem ir para a próxima que entrar
  logoutBtn.addEventListener('click', async () => {
    await Account.logout();
    friends = [];
    saveFriends();
    location.reload();
  });

  // ---------------------------------------------------------------- entrar: o QR é o link do Discord para abrir no celular
  let qrFor = 0; // quando o QR atual vence
  let qrBusy = false;
  function loadQrLib() {
    return window.qrcode ? Promise.resolve() : new Promise((ok, bad) => {
      const s = make('script');
      s.src = 'qrcode.js';
      s.onload = ok;
      s.onerror = bad;
      document.head.append(s);
    });
  }
  function drawQr(url) {
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const cell = Math.floor(qrBox.width / (n + 8)); // 4 módulos de margem branca de cada lado, exigidos pelos leitores
    const start = Math.floor((qrBox.width - cell * n) / 2);
    const g = qrBox.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, qrBox.width, qrBox.height);
    g.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) g.fillRect(start + x * cell, start + y * cell, cell, cell);
  }
  async function refreshQr() {
    if (qrBusy || !net.peer?.open || Date.now() < qrFor) return;
    qrBusy = true;
    try {
      await loadQrLib();
      drawQr(await Account.startQr());
      qrFor = Date.now() + 9 * 60_000; // o pedido vive 10 minutos no servidor
      qrBox.dataset.ready = '1';
    } catch (err) {
      console.warn('qr', err.message);
      qrFor = Date.now() + 15_000; // servidor fora do ar ou limite de pedidos: tenta de novo em instantes
    }
    qrBusy = false;
  }

  // ---------------------------------------------------------------- amigos
  const rowOf = new Map();
  function rowFor(f) {
    let r = rowOf.get(f.code);
    if (!r) {
      r = make('button', 'tvRow');
      r.type = 'button';
      r.append(make('span', 'tvDot'), make('span', 'tvName'), make('span', 'tvInfo'));
      r.addEventListener('click', () => {
        if (incoming.has(f.code)) answerFriend(f.code, true);
        else if (watch.code === f.code) leave(true);
        else requestWatch(f.code);
      });
      rowOf.set(f.code, r);
    }
    return r;
  }
  const put = (e, text) => { if (e.textContent !== text) e.textContent = text; };
  function renderRows() {
    const live = friends.filter((f) => !f.pending && net.links.get(f.code)?.info.live);
    // Mais de um aparelho da mesma pessoa aparece uma vez só; quem está ao vivo vem primeiro
    const others = shownFriends().filter((f) => !f.pending && !live.some((l) => l.code === f.code || (l.d && l.d === f.d)));
    const asking = [...incoming].map(([code, { name }]) => ({ code, name }));
    const shown = [...asking, ...live, ...others];
    for (const f of shown) {
      const r = rowFor(f);
      const isLive = live.includes(f);
      const isAsking = asking.includes(f);
      r.disabled = !isLive && !isAsking;
      r.classList.toggle('live', isLive || isAsking);
      put(r.children[1], isAsking ? f.name || prettyCode(f.code) : friendName(f.code));
      const info = net.links.get(f.code)?.info;
      put(r.children[2], isAsking ? 'Pedido de amizade · OK aceita' : watch.code === f.code ? 'Entrando… (OK cancela)'
        : !isLive ? (net.links.has(f.code) ? 'Online' : 'Offline')
          : info.mode === 'public' ? 'Ao vivo · Assistir' : 'Ao vivo · Pedir para assistir');
    }
    const want = shown.map(rowFor);
    if (want.length !== rows.children.length || want.some((r, i) => rows.children[i] !== r)) {
      const had = document.activeElement;
      rows.replaceChildren(...want);
      if (had?.isConnected) had.focus();
    }
    let empty = rows.querySelector('.tvEmpty');
    if (!want.length && !empty) {
      empty = make('p', 'tvEmpty', 'Nenhum amigo ainda. Adicione pelo Telinha no PC ou no celular.');
      rows.append(empty);
    }
  }

  function render() {
    if (root.classList.contains('immersive')) return; // assistindo: nada de trabalho de tela por cima do vídeo
    const account = Account.state().d;
    login.classList.toggle('hidden', !!account);
    list.classList.toggle('hidden', !account);
    logoutBtn.classList.toggle('hidden', !account);
    put(mine, `Este aparelho: ${prettyCode(myCode)}`);
    put(state, $('peerStatus').textContent);
    if (account) {
      qrFor = 0;
      qrBox.dataset.ready = '';
      renderRows();
    } else {
      put(confirmLine, `3. Confirme o código ${prettyCode(myCode)}.`);
      refreshQr();
    }
    const active = document.activeElement;
    if (active === document.body || !active?.isConnected || !focusable().includes(active)) select(focusable()[0]);
  }

  // ---------------------------------------------------------------- controle remoto
  const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const isOk = (e) => e.key === 'Enter' || e.keyCode === 13 || e.keyCode === 23;
  const watching = () => root.classList.contains('immersive');

  function focusable() {
    return [...(panelOpen() ? panel : app).querySelectorAll('button, input')].filter((el) => !el.disabled && el.getClientRects().length);
  }
  const gap = (a1, a2, b1, b2) => Math.max(0, b1 - a2, a1 - b2);
  // O mais perto naquela direção; quem não está alinhado conta como três vezes mais longe
  function move(dx, dy) {
    const items = focusable();
    const from = document.activeElement;
    if (!items.includes(from)) return select(items[0]);
    const a = from.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const along = dx ? (dx > 0 ? b.left - a.right : a.left - b.right) : (dy > 0 ? b.top - a.bottom : a.top - b.bottom);
      if (along < -1) continue;
      const score = along + 3 * (dx ? gap(a.top, a.bottom, b.top, b.bottom) : gap(a.left, a.right, b.left, b.right));
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return select(best);
  }
  // O teclado da TV abre assim que um campo recebe foco e prende as setas: só selecionar não pode abrir, só o OK
  function select(el) {
    if (el?.tagName === 'INPUT') el.readOnly = true;
    el?.focus();
  }
  function openKeyboard(el) {
    el.readOnly = false;
    el.blur();
    el.focus();
  }
  // Num campo de texto aberto, esquerda e direita andam no texto até chegar na ponta
  function caretStays(el, dx) {
    if (!dx || el.tagName !== 'INPUT' || el.readOnly || el.selectionStart == null) return false;
    return dx < 0 ? el.selectionStart > 0 : el.selectionEnd < el.value.length;
  }

  document.addEventListener('keydown', (e) => {
    const dir = DIRS[e.key];
    if (isOk(e) && e.repeat) return e.preventDefault(); // segurar o botão não repete a escolha
    if (panelOpen()) {
      if (!dir && !isOk(e)) return undefined;
      e.preventDefault();
      if (dir?.[1]) move(...dir);
      else changeRow(document.activeElement, dir ? dir[0] : 1);
      return undefined;
    }
    if (watching()) {
      if (dir) e.preventDefault();
      else if (isOk(e)) {
        e.preventDefault();
        // O sistema bloqueou o som: o primeiro OK libera; depois, OK abre a qualidade
        if (!$('unmuteBtn').classList.contains('hidden')) $('unmuteBtn').click();
        else openPanel();
      }
      return undefined;
    }
    const field = document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
    if (dir) {
      if (caretStays(document.activeElement, dir[0])) return undefined;
      e.preventDefault();
      move(...dir);
    // Campo vazio: OK sempre abre o teclado, mesmo depois de fechá-lo com Voltar. Com texto, envia
    } else if (isOk(e) && field && (field.readOnly || !field.value)) {
      e.preventDefault();
      openKeyboard(field);
    }
    return undefined;
  }, true);

  let armed = 0;
  // Chamado pelo botão Voltar (MainActivity.java). false = o app pode fechar
  function back() {
    if (panelOpen()) {
      closePanel();
      return true;
    }
    if (watch.state === 'watching' && Date.now() - armed > 3000) {
      armed = Date.now();
      toast('Aperte Voltar de novo para sair da transmissão.');
      return true;
    }
    if (watch.code) {
      leave(true);
      render();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- qualidade: o que mais pesa no vídeo
  // Automática: 1080p a 30 quadros e até 20 Mbps, sem perder quadros na TV de 1,8 GB. A 60 quadros ela perde até 80%, com qualquer codec
  // e em 720p também (limite do caminho do vídeo no WebView). Se ainda perder mais de 15% dos
  // quadros em duas medidas seguidas, desce para 720p até fechar o app, sem cortar o bitrate.
  // Manual: resolução, quadros e bitrate escolhidos aqui, salvos, sem descer sozinho. Quem transmite aplica só na cópia da TV,
  // sem passar do que configurou lá. A versão antiga de quem transmite ignora "custom" e usa só o "q".
  const AUTO_FULL = { height: 1080, fps: 30, mbps: 20 };
  const AUTO_LOW = { height: 720, fps: 30, mbps: 8 };
  const ROWS = [
    { key: 'auto', label: 'Modo', values: [true, false], show: (v) => (v ? 'Automática' : 'Manual') },
    { key: 'height', label: 'Resolução', values: [1080, 720, 480], show: (v) => `${v}p` },
    { key: 'fps', label: 'Quadros por segundo', values: [60, 30], show: (v) => `${v} fps` },
    { key: 'mbps', label: 'Bitrate', values: [3, 5, 8, 12, 20, 30, 50], show: (v) => `${v} Mbps` },
  ];
  const savedQuality = storeJson('telinha.tvQuality');
  const choice = { auto: true, height: 1080, fps: 60, mbps: 20 };
  for (const row of ROWS) if (row.values.includes(savedQuality?.[row.key])) choice[row.key] = savedQuality[row.key];
  let descended = false;
  let lastVideo = null;
  let badChecks = 0;

  function qualityMsg() {
    const c = choice.auto ? (descended ? AUTO_LOW : AUTO_FULL) : choice;
    return { t: 'quality', q: c.height <= 480 ? 'low' : c.height <= 720 ? 'eco' : 'auto', custom: { height: c.height, fps: c.fps, mbps: c.mbps } };
  }
  function applyQuality() {
    badChecks = 0;
    if (watch.state === 'watching') send(watch.code, qualityMsg());
  }

  const panel = make('div');
  panel.id = 'tvQuality';
  panel.classList.add('hidden');
  const liveLine = make('p', 'tvQLive');
  const rowEls = ROWS.map((row) => {
    const b = make('button', 'tvQRow');
    b.type = 'button';
    b.append(make('span', null, row.label), make('b'));
    b.row = row;
    return b;
  });
  panel.append(make('h2', null, 'Qualidade'), ...rowEls, liveLine, make('p', 'tvQHelp', 'Setas mudam · Voltar fecha · Quem transmite pode limitar'));
  document.body.append(panel);
  function panelOpen() { return !panel.classList.contains('hidden'); }
  function paintPanel() {
    for (const b of rowEls) {
      const from = b.row.key === 'auto' || !choice.auto ? choice : descended ? AUTO_LOW : AUTO_FULL;
      b.children[1].textContent = b.row.show(from[b.row.key]);
      b.classList.toggle('off', b.row.key !== 'auto' && choice.auto);
    }
  }
  function changeRow(el, step) {
    const { row } = el;
    if (!row) return;
    const at = row.values.indexOf(choice[row.key]);
    choice[row.key] = row.values[(at + step + row.values.length) % row.values.length];
    if (row.key !== 'auto') choice.auto = false; // mexeu num valor: passa para Manual
    else descended = false;
    storeJson('telinha.tvQuality', choice);
    paintPanel();
    applyQuality();
  }
  // O que está chegando de verdade, para ver o limite de quem transmite ou da rede. Só mede com o painel aberto
  let liveTimer = 0;
  let liveLast = null;
  async function paintLive() {
    const pc = watch.call?.peerConnection;
    if (!pc) return put(liveLine, 'Sem transmissão agora.');
    let v = null;
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') v = s; });
    if (!v) return undefined;
    if (liveLast) put(liveLine, `Recebendo: ${v.frameWidth || 0}x${v.frameHeight || 0} · ${Math.round(v.framesPerSecond || 0)} fps · ${(((v.bytesReceived - liveLast.bytes) * 8) / ((v.timestamp - liveLast.at) * 1000)).toFixed(1)} Mbps`);
    liveLast = { bytes: v.bytesReceived, at: v.timestamp };
    return undefined;
  }
  function openPanel() {
    panel.classList.remove('hidden');
    paintPanel();
    liveLast = null;
    put(liveLine, 'Medindo…');
    paintLive();
    liveTimer = setInterval(paintLive, 1000);
    rowEls[0].focus();
  }
  function closePanel() {
    clearInterval(liveTimer);
    panel.classList.add('hidden');
    document.activeElement?.blur();
    if (!watching()) qualityBtn.focus();
  }
  qualityBtn.addEventListener('click', openPanel);

  function checkDrops(v) {
    if (!choice.auto || descended) return;
    if (lastVideo) {
      const decoded = v.framesDecoded - lastVideo.framesDecoded;
      badChecks = decoded >= 30 && v.framesDropped - lastVideo.framesDropped > decoded * 0.15 ? badChecks + 1 : 0;
      if (badChecks >= 2) {
        descended = true;
        applyQuality();
      }
    }
    lastVideo = v;
  }
  setInterval(async () => {
    const pc = watch.call?.peerConnection;
    if (watch.state !== 'watching' || !pc) {
      lastVideo = null;
      badChecks = 0;
      return;
    }
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') checkDrops(s); });
  }, 5000);

  window.TelinhaTV = { back, checkDrops, qualityMsg };
  setInterval(render, 1000);
  render();
})();
