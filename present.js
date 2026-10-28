/* global $, host, watch, net, send, friendName, myName, myCode, toast, peerIdFor, codeOfPeer, hostSettings, capture,
   createAudioTrack, setPcAudio, destroyAudio, tuneSdp, tuneSenders, openPicker, broadcastStatus, updateLiveBox, refreshUI */
/* Telinha · quem apresenta a tela na sala. A sala é de quem a abriu (o dono) e continua aberta mesmo sem ninguém
   apresentando: chat, voz, câmeras e desenho seguem. Uma pessoa apresenta por vez: o dono ou alguém que está
   assistindo. Quem assiste e apresenta manda a tela só para o dono, que repassa para a sala pela mesma ligação
   de sempre (troca a faixa de vídeo e de som de cada espectador): quem assiste não precisa de nada novo, e a
   qualidade, as estatísticas e a latência continuam valendo. Sem ninguém apresentando, vai um quadro avisando. */
'use strict';

const Present = (() => {
  // ---------------------------------------------------------------- quadro "ninguém apresentando"
  // Um canvas que se redesenha a cada segundo: o vídeo de quem assiste continua tocando (e o som junto)
  let idle = null;
  function idleTrack() {
    if (idle && idle.track.readyState === 'live') return idle.track;
    const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const g = c.getContext('2d');
    const paint = () => {
      g.fillStyle = '#0d0f12';
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.font = '600 44px "Segoe UI", system-ui, sans-serif';
      g.fillText('Ninguém está apresentando agora', 640, 340);
      g.fillStyle = 'rgba(255, 255, 255, .6)';
      g.font = '28px "Segoe UI", system-ui, sans-serif';
      g.fillText(`A sala de ${myName()} continua aberta: chat, voz e câmeras seguem`, 640, 400);
    };
    paint();
    const track = c.captureStream(5).getVideoTracks()[0];
    idle = { track, timer: setInterval(paint, 1000) };
    return track;
  }
  function dropIdle() {
    if (!idle) return;
    clearInterval(idle.timer);
    idle.track.stop();
    idle = null;
  }

  // ---------------------------------------------------------------- dono da sala
  // presenter: null (ninguém), myCode (o dono) ou o código de quem assiste
  const room = { presenter: null, own: null, call: null, remote: null, pending: null };

  // O que a sala recebe agora: vídeo e som de quem apresenta (o som do PC do dono quando é ele ou ninguém)
  function roomTracks() {
    if (room.presenter === myCode && room.own) return { video: room.own, audio: host.audio };
    if (room.remote) return { video: room.remote.getVideoTracks()[0] || idleTrack(), audio: room.remote.getAudioTracks()[0] || host.audio };
    return { video: idleTrack(), audio: host.audio };
  }

  // Troca o que vai para cada espectador. Quem está apresentando não recebe a própria tela de volta.
  async function apply() {
    const { video, audio } = roomTracks();
    host.stream = new MediaStream([video, audio].filter(Boolean));
    $('preview').srcObject = host.stream;
    $('previewEmpty').classList.add('hidden');
    for (const [code, v] of host.viewers) {
      const self = code === room.presenter;
      for (const s of v.call.peerConnection?.getSenders() || []) {
        const kind = s.track?.kind || (s === v.videoSender ? 'video' : s === v.audioSender ? 'audio' : null);
        if (kind === 'video') { v.videoSender = s; await s.replaceTrack(self ? null : video).catch(() => {}); }
        if (kind === 'audio') { v.audioSender = s; await s.replaceTrack(self ? null : audio).catch(() => {}); }
      }
    }
    for (const v of host.viewers.values()) tuneSenders(v.call.peerConnection, v.quality, v.stats?.relay);
    announce();
    renderHost();
  }

  // Avisa a sala de quem está apresentando
  function announce() {
    const msg = { t: 'presenter', code: room.presenter, name: room.presenter === myCode ? myName() : room.presenter ? friendName(room.presenter) : '' };
    for (const code of host.viewers.keys()) send(code, msg);
    broadcastStatus();
    refreshUI();
  }

  // O dono abriu a sala apresentando a própria tela (app.js, startHost)
  function hostStarted(video) {
    room.presenter = myCode;
    room.own = video;
    renderHost();
  }

  // O dono para de apresentar: a sala continua
  async function stopOwn() {
    if (room.own) room.own.stop();
    room.own = null;
    if (room.presenter === myCode) room.presenter = null;
    window.telinha.overlayDraw?.({ op: 'reset' });
    window.telinha.overlayHide?.();
    await apply();
    toast('Você parou de apresentar. A sala continua aberta.');
  }

  // O dono volta a apresentar (ou começa, se a sala estava sem ninguém)
  async function startOwn() {
    if (room.presenter && room.presenter !== myCode) return toast(`${friendName(room.presenter)} está apresentando. Pare a apresentação dela antes.`, true);
    if (!host.sourceId) return openPicker((s) => { host.sourceId = s.id; startOwn(); });
    try {
      const captured = await capture(hostSettings());
      room.own = captured.getVideoTracks()[0];
    } catch (err) {
      return toast(`Não foi possível capturar: ${err.message}`, true);
    }
    room.presenter = myCode;
    await apply();
  }

  // A fonte que o dono capturava foi fechada (janela fechou): para de apresentar, a sala fica
  function ownEnded(track) {
    if (track !== room.own) return false;
    toast('A fonte que você apresentava foi fechada. A sala continua aberta.', true);
    stopOwn();
    return true;
  }

  // Troca de fonte com o dono apresentando
  function switchOwn(video) {
    const old = room.own;
    room.own = video;
    apply().then(() => old?.stop());
  }

  // Alguém que assiste pediu para apresentar
  function onRequest(code) {
    if (!host.viewers.has(code)) return;
    if (room.presenter) {
      send(code, { t: 'present-no', reason: `${room.presenter === myCode ? myName() : friendName(room.presenter)} já está apresentando.` });
      return;
    }
    room.pending = code;
    send(code, { t: 'present-ok' });
  }

  // A tela de quem assiste chegou: passa a ser a da sala
  function onIncoming(call) {
    const code = codeOfPeer(call.peer);
    if (!code || code !== room.pending || !host.viewers.has(code)) return call.close();
    room.pending = null;
    room.call?.close();
    room.call = call;
    call.answer(undefined, { sdpTransform: (sdp) => tuneSdp(sdp, call.metadata || {}) });
    call.on('stream', (stream) => {
      if (room.call !== call) return;
      // o dono estava apresentando? (não deveria: pediu antes) — para a dele
      if (room.own) { room.own.stop(); room.own = null; }
      room.presenter = code;
      room.remote = stream;
      apply();
      toast(`${friendName(code)} está apresentando a tela.`);
    });
    const gone = () => { if (room.call === call) presenterGone(); };
    call.on('close', gone);
    call.on('error', gone);
    call.peerConnection?.addEventListener('connectionstatechange', () => {
      if (call.peerConnection.connectionState === 'failed') gone();
    });
  }

  function presenterGone() {
    const who = room.presenter;
    room.call = null;
    room.remote = null;
    if (who && who !== myCode) {
      room.presenter = null;
      apply();
      toast(`${friendName(who)} parou de apresentar. A sala continua aberta.`);
    }
  }

  // O dono para a apresentação de quem assiste
  function stopViewer() {
    const who = room.presenter;
    if (!who || who === myCode) return;
    send(who, { t: 'present-stop' });
    try { room.call?.close(); } catch {}
    presenterGone();
  }

  function onViewerJoin(code) {
    send(code, { t: 'presenter', code: room.presenter, name: room.presenter === myCode ? myName() : room.presenter ? friendName(room.presenter) : '' });
  }
  function onViewerLeave(code) {
    if (room.pending === code) room.pending = null;
    if (room.presenter === code) { try { room.call?.close(); } catch {} presenterGone(); }
  }

  function renderHost() {
    const open = !!host.stream;
    const me = room.presenter === myCode;
    const other = room.presenter && !me;
    $('presentBtn').classList.toggle('hidden', !open);
    $('presentBtn').textContent = me ? 'Parar de apresentar (a sala continua)' : 'Apresentar minha tela';
    $('presentBtn').disabled = !!other;
    $('presenterInfo').classList.toggle('hidden', !open);
    $('presenterInfo').textContent = me ? 'Você está apresentando a sua tela.' : other ? `${friendName(room.presenter)} está apresentando a tela dela.` : 'Ninguém está apresentando. A sala continua aberta.';
    $('stopPresenter').classList.toggle('hidden', !other);
    $('stopPresenter').textContent = other ? `Parar a apresentação de ${friendName(room.presenter)}` : '';
  }

  // Sala fechada (app.js, stopHost)
  function reset() {
    try { room.call?.close(); } catch {}
    Object.assign(room, { presenter: null, own: null, call: null, remote: null, pending: null });
    dropIdle();
    setTimeout(renderHost, 0); // depois de app.js terminar de fechar a sala
  }

  // ---------------------------------------------------------------- quem assiste
  const me = { stream: null, call: null, asking: false };
  let presenterNow = { code: null, name: '' };

  async function startViewer() {
    if (watch.state !== 'watching') return toast('Entre numa transmissão para apresentar a sua tela.', true);
    if (presenterNow.code) return toast(`${presenterNow.name || 'Alguém'} já está apresentando.`, true);
    if (!net.peer?.open) return toast('Ainda conectando ao servidor, tente em alguns segundos.', true);
    openPicker(async (s) => {
      host.sourceId = s.id;
      try {
        const captured = await capture(hostSettings());
        captured.getVideoTracks()[0].addEventListener('ended', () => stopViewerSelf(true));
        captured.addTrack(await createAudioTrack());
        if ($('audio').checked) await setPcAudio(true);
        // o som do PC de quem apresenta não pode levar de volta as vozes da sala
        window.telinha.audioExcludeSelf?.(true);
        me.stream = captured;
      } catch (err) {
        return toast(`Não foi possível capturar: ${err.message}`, true);
      }
      me.asking = true;
      send(watch.code, { t: 'present-req' });
      renderViewer();
    });
  }

  function callHost() {
    if (!me.stream || !watch.code) return;
    me.asking = false;
    const cfg = hostSettings();
    const meta = { kind: 'present', codec: cfg.codec, kbps: cfg.mbps * 1000 };
    const call = net.peer.call(peerIdFor(watch.code), me.stream, { metadata: meta, sdpTransform: (sdp) => tuneSdp(sdp, meta) });
    me.call = call;
    call.peerConnection.addEventListener('connectionstatechange', () => {
      if (call.peerConnection.connectionState === 'connected') tuneSenders(call.peerConnection, null);
      if (call.peerConnection.connectionState === 'failed') stopViewerSelf(false, 'A conexão da apresentação falhou.');
    });
    call.on('close', () => { if (me.call === call) stopViewerSelf(false); });
    renderViewer();
  }

  function stopViewerSelf(sourceClosed, reason) {
    if (!me.stream && !me.call) return;
    try { me.call?.close(); } catch {}
    me.call = null;
    me.asking = false;
    me.stream?.getTracks().forEach((t) => t.stop());
    me.stream = null;
    destroyAudio();
    window.telinha.audioExcludeSelf?.(false);
    window.telinha.overlayDraw?.({ op: 'reset' });
    window.telinha.overlayHide?.();
    renderViewer();
    toast(reason || (sourceClosed ? 'A fonte que você apresentava foi fechada.' : 'Você parou de apresentar.'), !!reason);
  }

  function renderViewer() {
    const presenting = !!(me.call || me.asking);
    const btn = $('watchPresent');
    btn.textContent = presenting ? 'Parar de apresentar' : 'Apresentar minha tela';
    btn.classList.toggle('danger', presenting);
    btn.disabled = !presenting && !!presenterNow.code;
    $('watchPresentInfo').textContent = presenting ? 'Você está apresentando: a sala vê a sua tela.'
      : presenterNow.code ? `${presenterNow.code === watch.code ? 'Quem abriu a sala' : presenterNow.name} está apresentando.` : 'Ninguém está apresentando agora: você pode apresentar a sua tela.';
    $('watchWrap').classList.toggle('presentingSelf', presenting);
  }

  // ---------------------------------------------------------------- mensagens
  function onMessage(code, msg) {
    switch (msg.t) {
      case 'present-req': if (host.stream) onRequest(code); return;
      case 'present-ok': if (code === watch.code && me.asking) callHost(); return;
      case 'present-no':
        if (code === watch.code && me.asking) stopViewerSelf(false, String(msg.reason || 'Não deu para apresentar agora.').slice(0, 120));
        return;
      case 'present-stop':
        if (code === watch.code && (me.call || me.asking)) stopViewerSelf(false, 'Quem abriu a sala parou a sua apresentação.');
        return;
      case 'presenter':
        if (code !== watch.code) return;
        presenterNow = { code: typeof msg.code === 'string' ? msg.code : null, name: String(msg.name || '').slice(0, 24) };
        renderViewer();
        return;
      default:
    }
  }

  function onLeave() {
    stopViewerSelf(false);
    presenterNow = { code: null, name: '' };
    renderViewer();
  }

  $('presentBtn').addEventListener('click', () => (room.presenter === myCode ? stopOwn() : startOwn()));
  $('stopPresenter').addEventListener('click', stopViewer);
  $('watchPresent').addEventListener('click', () => (me.call || me.asking ? stopViewerSelf(false) : startViewer()));
  renderHost();
  renderViewer();

  return {
    hostStarted, ownEnded, switchOwn, onIncoming, onMessage, onViewerJoin, onViewerLeave, onLeave, reset,
    presenting: () => room.presenter === myCode || !!me.call, get presenter() { return room.presenter; }, apply,
  };
})();
window.Present = Present;
