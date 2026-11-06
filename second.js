/* Telinha · segunda tela: com alguém apresentando, outra pessoa que assiste pode apresentar junto. A tela dela vai
   só para o dono da sala, que repassa para cada espectador numa ligação à parte (como as câmeras), e aparece numa
   janela por cima do palco, que dá para arrastar e mudar de tamanho. Quem abriu a sala manda as duas telas:
   o upload dele dobra enquanto houver duas. Só vídeo: o som continua sendo o da tela principal. */
'use strict';

const Second = (() => {
  // ---------------------------------------------------------------- janela da segunda tela (todo mundo)
  let box = null;
  function show(stream, who, wrap) {
    if (!box) {
      box = document.createElement('div');
      box.className = 'screen2';
      box.innerHTML = '<video autoplay playsinline muted></video><div class="screen2Bar"><span></span></div>';
      const bar = box.querySelector('.screen2Bar');
      let drag = null;
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const r = box.getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
        bar.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      bar.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const w = box.parentElement.getBoundingClientRect(), r = box.getBoundingClientRect();
        const x = Math.min(Math.max(0, e.clientX - drag.dx - w.left), w.width - r.width);
        const y = Math.min(Math.max(0, e.clientY - drag.dy - w.top), w.height - r.height);
        Object.assign(box.style, { left: `${x}px`, top: `${y}px`, right: 'auto' });
      });
      bar.addEventListener('pointerup', () => { drag = null; });
      box.addEventListener('dblclick', () => box.querySelector('video').requestFullscreen?.().catch(() => {}));
    }
    box.querySelector('video').srcObject = stream;
    box.querySelector('span').textContent = `Tela de ${who}`;
    if (box.parentElement !== wrap) wrap.append(box);
    box.querySelector('video').play().catch(() => {});
  }
  function hide() {
    if (!box) return;
    box.querySelector('video').srcObject = null;
    box.remove();
  }

  // ---------------------------------------------------------------- dono da sala
  // second: quem apresenta a segunda tela { code, call, stream }; out: ligações que repassam para cada espectador
  const room = { pending: null, second: null, out: new Map() };
  const settings = () => { const c = hostSettings(); return { kind: 'second', codec: c.codec, kbps: c.mbps * 1000 }; };

  function relay(code) {
    if (!room.second || code === room.second.code || room.out.has(code) || !host.viewers.has(code)) return;
    const meta = { ...settings(), who: friendName(room.second.code) };
    const call = net.peer.call(peerIdFor(code), room.second.stream, { metadata: meta, sdpTransform: (sdp) => tuneSdp(sdp, meta) });
    room.out.set(code, call);
    call.peerConnection?.addEventListener('connectionstatechange', () => {
      if (call.peerConnection.connectionState === 'connected') tuneSenders(call.peerConnection, null);
    });
    call.on('close', () => { if (room.out.get(code) === call) room.out.delete(code); });
  }
  function onRequest(code) {
    if (!host.viewers.has(code)) return;
    if (room.second || room.pending) return send(code, { t: 'second-no', reason: 'Já tem uma segunda tela na sala.' });
    const main = window.Present?.presenter;
    if (!main) return send(code, { t: 'second-no', reason: 'Ninguém está apresentando: use Apresentar minha tela.' });
    if (main === code) return send(code, { t: 'second-no', reason: 'Você já está apresentando a tela principal.' });
    room.pending = code;
    send(code, { t: 'second-ok' });
  }
  function onIncomingHost(call) {
    const code = codeOfPeer(call.peer);
    if (!code || code !== room.pending || !host.viewers.has(code)) return call.close();
    room.pending = null;
    call.answer(undefined, { sdpTransform: (sdp) => tuneSdp(sdp, call.metadata || {}) });
    call.on('stream', (stream) => {
      room.second = { code, call, stream };
      for (const c of host.viewers.keys()) relay(c);
      show(stream, friendName(code), $('preview').closest('.videoWrap'));
      toast(`${friendName(code)} está apresentando uma segunda tela.`);
      renderHost();
    });
    const gone = () => { if (!room.second || room.second.call === call) dropHost(); };
    call.on('close', gone);
    call.on('error', gone);
  }
  function dropHost(kick) {
    const s = room.second;
    if (!s && !room.pending) return;
    if (kick && s) send(s.code, { t: 'second-stop' });
    try { s?.call.close(); } catch {}
    for (const c of room.out.values()) try { c.close(); } catch {}
    room.out.clear();
    room.second = null;
    room.pending = null;
    hide();
    renderHost();
  }
  function renderHost() {
    const s = room.second;
    $('stopSecond').classList.toggle('hidden', !s);
    $('stopSecond').textContent = s ? `Parar a segunda tela de ${friendName(s.code)}` : '';
  }

  // ---------------------------------------------------------------- quem assiste
  const me = { stream: null, call: null, asking: false };
  let presenter = null; // quem apresenta a tela principal (mensagem 'presenter' do dono)

  function start() {
    if (watch.state !== 'watching') return;
    openPicker(async (s) => {
      host.sourceId = s.id;
      try {
        me.stream = await capture(hostSettings());
        me.stream.getVideoTracks()[0].addEventListener('ended', () => stopSelf('A fonte da sua segunda tela foi fechada.'));
      } catch (err) {
        return toast(`Não foi possível capturar: ${err.message}`, true);
      }
      me.asking = true;
      send(watch.code, { t: 'second-req' });
      renderViewer();
    });
  }
  function callHost() {
    if (!me.stream || !watch.code) return;
    me.asking = false;
    const meta = { ...settings(), kind: 'second-in' };
    const call = net.peer.call(peerIdFor(watch.code), me.stream, { metadata: meta, sdpTransform: (sdp) => tuneSdp(sdp, meta) });
    me.call = call;
    call.peerConnection.addEventListener('connectionstatechange', () => {
      if (call.peerConnection.connectionState === 'connected') tuneSenders(call.peerConnection, null);
      if (call.peerConnection.connectionState === 'failed') stopSelf('A conexão da segunda tela falhou.');
    });
    call.on('close', () => { if (me.call === call) stopSelf(); });
    renderViewer();
  }
  function stopSelf(reason) {
    if (!me.stream && !me.call && !me.asking) return;
    const call = me.call;
    me.call = null;
    me.asking = false;
    try { call?.close(); } catch {}
    me.stream?.getTracks().forEach((t) => t.stop());
    me.stream = null;
    renderViewer();
    toast(reason || 'Você parou a segunda tela.', !!reason);
  }
  // A segunda tela de outra pessoa, repassada pelo dono
  let incoming = null;
  function onIncomingViewer(call) {
    if (codeOfPeer(call.peer) !== watch.code) return call.close();
    try { incoming?.close(); } catch {}
    incoming = call;
    call.answer(undefined, { sdpTransform: (sdp) => tuneSdp(sdp, call.metadata || {}) });
    call.on('stream', (stream) => { if (incoming === call) show(stream, String(call.metadata?.who || 'alguém').slice(0, 24), $('remote').closest('.videoWrap')); });
    const gone = () => { if (incoming === call) { incoming = null; hide(); } };
    call.on('close', gone);
    call.on('error', gone);
  }
  function renderViewer() {
    const mine = !!(me.call || me.asking);
    const b = $('watchSecond');
    // Só faz sentido com outra pessoa apresentando a principal (o aviso de quem apresenta só chega dentro de uma sala)
    b.classList.toggle('hidden', !mine && !(presenter && presenter !== myCode));
    b.textContent = mine ? 'Parar a segunda tela' : 'Apresentar junto (segunda tela)';
    b.classList.toggle('danger', mine);
  }

  $('stopSecond').addEventListener('click', () => dropHost(true));
  $('watchSecond').addEventListener('click', () => (me.call || me.asking ? stopSelf() : start()));
  renderHost();
  renderViewer();

  return {
    onIncoming(call) {
      if (call.metadata?.kind === 'second-in') return host.stream ? onIncomingHost(call) : call.close();
      return onIncomingViewer(call);
    },
    onMessage(code, msg) {
      switch (msg.t) {
        case 'second-req': if (host.stream) onRequest(code); return;
        case 'second-ok': if (code === watch.code && me.asking) callHost(); return;
        case 'second-no': if (code === watch.code && me.asking) stopSelf(String(msg.reason || 'Não deu agora.').slice(0, 120)); return;
        case 'second-stop': if (code === watch.code) stopSelf('Quem abriu a sala parou a sua segunda tela.'); return;
        case 'presenter':
          if (code !== watch.code) return;
          presenter = typeof msg.code === 'string' ? msg.code : null;
          renderViewer();
          return;
        default:
      }
    },
    onViewerJoin: relay,
    onViewerLeave(code) {
      if (room.pending === code || room.second?.code === code) dropHost();
      const c = room.out.get(code);
      if (c) { room.out.delete(code); try { c.close(); } catch {} }
    },
    onHostStop: () => dropHost(true),
    onLeave() {
      stopSelf();
      try { incoming?.close(); } catch {}
      incoming = null;
      presenter = null;
      hide();
      renderViewer();
    },
    state: () => ({ second: room.second?.code || null, out: room.out.size, me: !!me.call, showing: !!box?.isConnected }),
  };
})();
window.Second = Second;
