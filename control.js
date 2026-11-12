// Controle remoto: quem assiste pede, quem transmite permite (a decisão final é o diálogo do processo principal).
// Só funciona com a tela do próprio dono no app de PC. Uma pessoa por vez, e a permissão vale para aquela fonte.
const Control = (() => {
  const COOLDOWN = 30000; // quem teve o pedido negado espera antes de incomodar de novo
  const hosting = { code: null, sourceId: null, timer: null, deciding: false, wants: new Set(), denied: new Map() };
  const viewing = { state: 'off', keyboard: false, held: new Set(), buttons: new Set(), askTimer: null };

  // Gamepad: permissão à parte (só um controle de Xbox a mais, sem mouse nem teclado), até 4 pessoas juntas
  const padHost = { pads: new Map(), wants: new Set(), denied: new Map(), deciding: false, timer: null };
  const padView = { state: 'off', conn: null, timer: null, askTimer: null, seq: 0, last: '', sentAt: 0, warned: false, rumble: null, rumbleAt: 0 };

  // Quem está apresentando é o dono. Trocar de fonte não muda isso: o gamepad continua (o controle do PC tem conferência própria da fonte).
  const available = () => !!window.telinha?.controlGrant && !!host.stream && window.Present?.presenter === myCode;

  // ---------------------------------------------------------------- quem transmite

  function renderRow(code) {
    const v = host.viewers.get(code);
    if (!v?.ctlBtn) return;
    const on = hosting.code === code;
    v.ctlBtn.classList.toggle('hidden', !available());
    v.ctlBtn.classList.toggle('primary', on || hosting.wants.has(code));
    v.ctlBtn.textContent = on ? 'Tirar controle' : hosting.wants.has(code) ? 'Pediu controle' : 'Dar controle';
    v.ctlBtn.disabled = hosting.deciding || (!!hosting.code && !on);
    renderPadRow(code);
  }
  function renderPadRow(code) {
    const v = host.viewers.get(code);
    if (!v?.padBtn) return;
    const on = padHost.pads.has(code);
    v.padBtn.classList.toggle('hidden', !available());
    v.padBtn.classList.toggle('primary', on || padHost.wants.has(code));
    v.padBtn.textContent = on ? 'Tirar gamepad' : padHost.wants.has(code) ? 'Pediu gamepad' : 'Dar gamepad';
    v.padBtn.disabled = padHost.deciding;
  }
  const renderRows = () => { for (const code of host.viewers.keys()) renderRow(code); };

  function button(code) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.addEventListener('click', () => (hosting.code === code ? stopHosting(true) : grant(code)));
    return b;
  }

  async function grant(code) {
    if (hosting.code || hosting.deciding || !available() || !net.links.get(code)?.verified) return;
    const sourceId = host.sourceId;
    hosting.deciding = true;
    renderRows();
    let ok = false;
    try {
      ok = await window.telinha.controlGrant({ sourceId, name: friendName(code), code: prettyCode(code), friend: isFriend(code) });
    } finally {
      hosting.deciding = false;
    }
    hosting.wants.delete(code);
    if (!ok) {
      hosting.denied.set(code, Date.now());
      send(code, { t: 'control-state', on: false, reason: `${myName()} não deu o controle.` });
      renderRows();
      return;
    }
    // Enquanto o diálogo estava aberto, a pessoa saiu ou a fonte mudou
    if (!host.viewers.has(code) || host.sourceId !== sourceId || !available()) {
      window.telinha.controlStop();
      send(code, { t: 'control-state', on: false });
      renderRows();
      return;
    }
    hosting.code = code;
    hosting.sourceId = sourceId;
    // Permissão vale para a fonte escolhida: trocar de tela ou passar a apresentação encerra o controle
    hosting.timer = setInterval(() => { if (host.sourceId !== hosting.sourceId || !available()) stopHosting(true); }, 500);
    send(code, { t: 'control-state', on: true });
    host.events.push({ t: Date.now(), label: `${friendName(code)} recebeu o controle` });
    renderRows();
  }

  // tellMain = false quando foi o processo principal que encerrou (botão Parar, atalho, janela fechada)
  function stopHosting(tellMain) {
    const { code } = hosting;
    if (!code) return;
    hosting.code = null;
    clearInterval(hosting.timer);
    if (tellMain) window.telinha.controlStop();
    send(code, { t: 'control-state', on: false });
    toast(`${friendName(code)} não está mais controlando.`);
    host.events.push({ t: Date.now(), label: `${friendName(code)} perdeu o controle` });
    renderRows();
  }

  function padButton(code) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.addEventListener('click', () => (padHost.pads.has(code) ? stopPadHost(code, true) : grantPad(code)));
    return b;
  }

  async function grantPad(code) {
    if (padHost.pads.has(code) || padHost.deciding || !available() || !net.links.get(code)?.verified) return;
    padHost.deciding = true;
    renderRows();
    let ok = false;
    try {
      ok = await window.telinha.padGrant({ id: code, name: friendName(code), code: prettyCode(code), friend: isFriend(code) });
    } finally {
      padHost.deciding = false;
    }
    padHost.wants.delete(code);
    if (!ok) {
      padHost.denied.set(code, Date.now());
      send(code, { t: 'pad-state', on: false, reason: `${myName()} não deu o gamepad.` });
      renderRows();
      return;
    }
    if (!host.viewers.has(code) || !available()) {
      window.telinha.padStop(code);
      send(code, { t: 'pad-state', on: false });
      renderRows();
      return;
    }
    padHost.pads.set(code, { conn: null, seq: -1 });
    padHost.timer ||= setInterval(() => { if (!available()) for (const c of [...padHost.pads.keys()]) stopPadHost(c, true); }, 500);
    send(code, { t: 'pad-state', on: true });
    host.events.push({ t: Date.now(), label: `${friendName(code)} recebeu um gamepad` });
    renderRows();
  }

  // tellMain = false quando foi o processo principal que encerrou (atalho, processo do controle caiu)
  function stopPadHost(code, tellMain) {
    const pad = padHost.pads.get(code);
    if (!pad) return;
    padHost.pads.delete(code);
    if (!padHost.pads.size) {
      clearInterval(padHost.timer);
      padHost.timer = null;
    }
    try { pad.conn?.close(); } catch {}
    if (tellMain) window.telinha.padStop(code);
    send(code, { t: 'pad-state', on: false });
    toast(`${friendName(code)} não está mais com o gamepad.`);
    renderRows();
  }

  // Canal à parte, sem ordem garantida: um pacote perdido não segura os seguintes. Cada mensagem é o estado inteiro.
  function onPadConnection(conn) {
    const code = normalizeCode(conn.metadata?.code);
    const pad = code && peerIdFor(code) === conn.peer && net.links.get(code)?.verified ? padHost.pads.get(code) : null;
    if (!pad || pad.conn) return conn.close();
    pad.conn = conn;
    conn.on('data', (m) => {
      if (padHost.pads.get(code) !== pad || !Array.isArray(m) || !(m[0] > pad.seq)) return;
      pad.seq = m[0];
      window.telinha.padInput(code, m.slice(1));
    });
    return undefined;
  }

  function onPadAsk(code) {
    let reason = null;
    if (!available()) reason = 'Esta transmissão não aceita gamepad.';
    else if (!host.viewers.has(code) || !net.links.get(code)?.verified) reason = 'Não foi possível confirmar sua identidade.';
    else if (Date.now() - (padHost.denied.get(code) || 0) < COOLDOWN) reason = 'Espere um pouco para pedir de novo.';
    if (reason) return send(code, { t: 'pad-state', on: false, reason });
    if (padHost.pads.has(code)) return send(code, { t: 'pad-state', on: true });
    if (padHost.wants.has(code)) return undefined;
    padHost.wants.add(code);
    const text = `${friendName(code)} quer jogar com o próprio gamepad.`;
    toast(`${text} Decida na lista de quem está assistindo.`);
    window.telinha.attention();
    window.telinha.notify?.({ title: 'Pedido de gamepad', body: `${text} Abra o Telinha para decidir.` });
    renderPadRow(code);
    return undefined;
  }

  window.telinha?.onPadEnded?.((code) => stopPadHost(code, false));
  window.telinha?.onPadRumble?.((code, l, s) => { if (padHost.pads.has(code)) send(code, { t: 'pad-rumble', l, s }); });

  function onAsk(code) {
    let reason = null;
    if (!available()) reason = 'Esta transmissão não aceita controle remoto.';
    else if (hosting.code) reason = `${friendName(hosting.code)} já está controlando.`;
    else if (!host.viewers.has(code) || !net.links.get(code)?.verified) reason = 'Não foi possível confirmar sua identidade.';
    else if (Date.now() - (hosting.denied.get(code) || 0) < COOLDOWN) reason = 'Espere um pouco para pedir de novo.';
    if (reason) return send(code, { t: 'control-state', on: false, reason });
    if (hosting.wants.has(code)) return undefined;
    hosting.wants.add(code);
    // Não abre o diálogo sozinho: tomaria o foco de um jogo a cada pedido
    const text = `${friendName(code)} pediu para controlar seu PC.`;
    toast(`${text} Decida na lista de quem está assistindo.`);
    window.telinha.attention();
    window.telinha.notify?.({ title: 'Pedido de controle', body: `${text} Abra o Telinha para decidir.` });
    renderRow(code);
    return undefined;
  }

  window.telinha?.onControlEnded?.(() => stopHosting(false));

  function onViewerLeave(code) {
    hosting.wants.delete(code);
    if (hosting.code === code) stopHosting(true);
    padHost.wants.delete(code);
    stopPadHost(code, true);
  }
  function onHostStop() {
    stopHosting(true);
    hosting.wants.clear();
    hosting.denied.clear();
    for (const code of [...padHost.pads.keys()]) stopPadHost(code, true);
    padHost.wants.clear();
    padHost.denied.clear();
  }

  // ---------------------------------------------------------------- quem assiste

  const canAsk = () => !TV && !matchMedia('(hover: none)').matches && watch.state === 'watching' && net.links.get(watch.code)?.info.control === true;
  const input = (m) => send(watch.code, { t: 'control-input', ...m });

  function releaseHeld() {
    if (viewing.state === 'on') {
      for (const c of viewing.held) input({ k: 'c', c, down: false });
      for (const b of viewing.buttons) input({ k: 'u', b });
    }
    viewing.held.clear();
    viewing.buttons.clear();
  }

  function setKeyboard(on) {
    if (viewing.keyboard && !on) releaseHeld();
    viewing.keyboard = on;
    $('watchWrap').classList.toggle('controlKeys', on);
  }

  function setViewing(state) {
    clearTimeout(viewing.askTimer);
    if (state !== 'on') setKeyboard(false);
    if (state === 'off' && viewing.state === 'on') releaseHeld();
    viewing.state = state;
    $('watchWrap').classList.toggle('controlling', state === 'on');
    refresh();
  }

  function refresh() {
    const btn = $('controlBtn');
    btn.classList.toggle('hidden', !canAsk() && viewing.state === 'off');
    btn.classList.toggle('primary', viewing.state === 'on');
    btn.textContent = { off: 'Pedir controle do PC', asking: 'Aguardando… (cancelar)', on: 'Parar de controlar' }[viewing.state];
    const padBtn = $('padBtn');
    padBtn.classList.toggle('hidden', !canAsk() && padView.state === 'off');
    padBtn.classList.toggle('primary', padView.state === 'on');
    padBtn.textContent = { off: 'Jogar com meu gamepad', asking: 'Aguardando… (cancelar)', on: 'Parar de usar o gamepad' }[padView.state];
    renderRows();
  }

  $('controlBtn').addEventListener('click', () => {
    if (viewing.state === 'off') {
      setViewing('asking');
      send(watch.code, { t: 'control-ask' });
      // Quem transmite pode nunca responder (fora do PC): o botão não fica preso
      viewing.askTimer = setTimeout(() => {
        send(watch.code, { t: 'control-cancel' });
        setViewing('off');
        toast('O pedido de controle não foi respondido.');
      }, 120000);
    } else {
      send(watch.code, { t: 'control-cancel' });
      setViewing('off');
    }
  });

  const overControls = (e) => e.target.closest?.('.reactBar, .fsBtn, .unmuteBtn, .videoVol');
  const wrap = $('watchWrap');
  // Fase de captura: nada de apontar, desenhar ou tela cheia por duplo clique durante o controle
  wrap.addEventListener('pointermove', (e) => {
    if (viewing.state !== 'on' || overControls(e)) return;
    const p = window.Room.videoPoint($('remote'), e);
    if (p) input({ k: 'm', x: p[0], y: p[1] });
  }, true);
  wrap.addEventListener('pointerdown', (e) => {
    if (viewing.state !== 'on' || overControls(e) || e.pointerType !== 'mouse' || e.button > 2) return;
    const p = window.Room.videoPoint($('remote'), e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    setKeyboard(true);
    document.activeElement?.blur?.();
    wrap.setPointerCapture(e.pointerId);
    viewing.buttons.add(e.button);
    input({ k: 'm', x: p[0], y: p[1] });
    input({ k: 'd', b: e.button });
  }, true);
  const pointerUp = (e) => {
    if (viewing.state !== 'on' || !viewing.buttons.delete(e.button)) return;
    e.stopPropagation();
    input({ k: 'u', b: e.button });
  };
  wrap.addEventListener('pointerup', pointerUp, true);
  wrap.addEventListener('pointercancel', () => { if (viewing.state === 'on') releaseHeld(); }, true);
  wrap.addEventListener('wheel', (e) => {
    if (viewing.state !== 'on' || overControls(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // Um passo da roda: cerca de 100 no navegador, 120 no Windows
    input({ k: 'w', v: -e.deltaY * 1.2, h: e.deltaX * 1.2 });
  }, { capture: true, passive: false });
  for (const type of ['dblclick', 'contextmenu', 'click']) {
    wrap.addEventListener(type, (e) => {
      if (viewing.state !== 'on' || overControls(e)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  // Clicou fora do vídeo (chat, por exemplo): o teclado volta para cá
  addEventListener('pointerdown', (e) => { if (viewing.keyboard && !wrap.contains(e.target)) setKeyboard(false); }, true);
  addEventListener('blur', () => setKeyboard(false));
  for (const [type, down] of [['keydown', true], ['keyup', false]]) {
    addEventListener(type, (e) => {
      if (!viewing.keyboard || viewing.state !== 'on') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (down) viewing.held.add(e.code);
      else if (!viewing.held.delete(e.code)) return;
      input({ k: 'c', c: e.code, down });
    }, true);
  }

  // ---------------------------------------------------------------- quem assiste: gamepad

  const firstPad = () => {
    const list = [...navigator.getGamepads()].filter((p) => p?.connected);
    return list.find((p) => p.mapping === 'standard') || list[0];
  };

  // Mapeamento padrão do navegador para o Xbox 360 (índice = botão; 6 e 7 são os gatilhos; 16, o Guide, não vai).
  // Só o eixo Y é invertido: no navegador, para cima é negativo.
  const XUSB = [0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80, 1, 2, 4, 8];
  function readPad(p) {
    let buttons = 0;
    XUSB.forEach((bit, i) => { if (bit && p.buttons[i]?.pressed) buttons |= bit; });
    const trigger = (i) => Math.round((p.buttons[i]?.value || 0) * 255);
    const stick = (i, sign) => Math.max(-32768, Math.min(32767, Math.round((p.axes[i] || 0) * sign * 32767)));
    return [buttons, trigger(6), trigger(7), stick(0, 1), stick(1, -1), stick(2, 1), stick(3, -1)];
  }

  function pollPad() {
    const pad = firstPad();
    if (!pad) {
      if (!padView.warned) toast('Nenhum gamepad encontrado. Conecte o controle e aperte um botão.');
      padView.warned = true;
      return;
    }
    padView.warned = false;
    if (!padView.conn?.open) return;
    const state = readPad(pad);
    const text = state.join();
    const now = performance.now();
    // O efeito do navegador tem duração; o jogo só avisa quando a vibração muda
    if (padView.rumble && now - padView.rumbleAt > 1500) playRumble(pad);
    // Repete mesmo sem mudança: um pacote perdido não deixa um botão preso, e o outro lado sabe que a conexão vive
    if (text === padView.last && now - padView.sentAt < 100) return;
    padView.last = text;
    padView.sentAt = now;
    padView.conn.send([++padView.seq, ...state]);
  }

  function setPadView(state) {
    clearTimeout(padView.askTimer);
    if (state !== 'on') {
      clearInterval(padView.timer);
      padView.timer = null;
      if (padView.rumble) firstPad()?.vibrationActuator?.reset?.();
      padView.rumble = null;
      try { padView.conn?.close(); } catch {}
      padView.conn = null;
    }
    padView.state = state;
    refresh();
  }

  function startPadView() {
    setPadView('on');
    Object.assign(padView, { seq: 0, last: '', sentAt: 0, warned: false });
    const conn = net.peer.connect(peerIdFor(watch.code), { reliable: false, metadata: { kind: 'pad', code: myCode } });
    padView.conn = conn;
    // O canal do gamepad caiu ou foi recusado: avisa em vez de parecer ligado sem funcionar
    conn.on('close', () => {
      if (padView.conn !== conn) return;
      send(watch.code, { t: 'pad-cancel' });
      setPadView('off');
      toast('A conexão do gamepad caiu. Peça de novo.', true);
    });
    padView.timer = setInterval(pollPad, 8);
    toast('Seu gamepad está valendo no PC de quem transmite.');
  }

  $('padBtn').addEventListener('click', () => {
    if (padView.state === 'off') {
      setPadView('asking');
      send(watch.code, { t: 'pad-ask' });
      padView.askTimer = setTimeout(() => {
        send(watch.code, { t: 'pad-cancel' });
        setPadView('off');
        toast('O pedido de gamepad não foi respondido.');
      }, 120000);
    } else {
      send(watch.code, { t: 'pad-cancel' });
      setPadView('off');
    }
  });

  function onPadState(code, msg) {
    if (code !== watch.code) return;
    if (msg.on === true) {
      if (padView.state !== 'on') startPadView();
    } else if (padView.state !== 'off') {
      const was = padView.state;
      setPadView('off');
      if (msg.reason) toast(String(msg.reason).slice(0, 120), true);
      else if (was === 'on') toast('O gamepad foi desligado.');
    }
  }

  function playRumble(pad) {
    padView.rumbleAt = performance.now();
    pad.vibrationActuator?.playEffect?.('dual-rumble', { duration: 2000, ...padView.rumble })?.catch?.(() => {});
  }

  function onPadRumble(code, msg) {
    if (code !== watch.code || padView.state !== 'on') return;
    const pad = firstPad();
    const level = (v) => Math.max(0, Math.min(1, (Number(v) || 0) / 255));
    padView.rumble = level(msg.l) || level(msg.s) ? { strongMagnitude: level(msg.l), weakMagnitude: level(msg.s) } : null;
    if (padView.rumble) playRumble(pad || {});
    else pad?.vibrationActuator?.reset?.();
  }

  function onState(code, msg) {
    if (code !== watch.code) return;
    if (msg.on === true) {
      if (viewing.state === 'on') return;
      window.Room.setPointing(false);
      if (window.Draw?.mode) window.Draw.setMode(false);
      setViewing('on');
      toast('Você está controlando. Clique no vídeo para usar o teclado; clique fora para soltar.');
    } else if (viewing.state !== 'off') {
      const was = viewing.state;
      setViewing('off');
      if (msg.reason) toast(String(msg.reason).slice(0, 120), true);
      else if (was === 'on') toast('O controle terminou.');
    }
  }

  function onMessage(code, msg) {
    switch (msg.t) {
      case 'control-ask':
        onAsk(code);
        break;
      case 'control-cancel':
        // Pedir e cancelar sem parar não pode virar uma chuva de avisos
        if (hosting.wants.delete(code)) hosting.denied.set(code, Date.now());
        if (hosting.code === code) stopHosting(true);
        else renderRow(code);
        break;
      case 'control-input':
        if (hosting.code === code) window.telinha.controlInput(msg);
        break;
      case 'control-state':
        onState(code, msg);
        break;
      case 'pad-ask':
        onPadAsk(code);
        break;
      case 'pad-cancel':
        if (padHost.wants.delete(code)) padHost.denied.set(code, Date.now());
        if (padHost.pads.has(code)) stopPadHost(code, true);
        else renderPadRow(code);
        break;
      case 'pad-state':
        onPadState(code, msg);
        break;
      case 'pad-rumble':
        onPadRumble(code, msg);
        break;
    }
  }

  function onLeave() {
    setViewing('off');
    setPadView('off');
  }

  return { onMessage, available, button, padButton, onPadConnection, renderRow, refresh, onViewerLeave, onHostStop, onLeave };
})();

window.Control = Control;
