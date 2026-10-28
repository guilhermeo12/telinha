/* global $, host, watch, net, send, friendName, myName, myCode, toast, store, storeJson, peerIdFor, codeOfPeer, normalizeCode */
/* Telinha · câmera e voz na sala. Quem liga a câmera ou o microfone manda um fluxo próprio (vídeo da
   câmera + voz no MESMO MediaStream, então boca e som chegam juntos) direto para cada pessoa da sala:
   quem transmite e quem assiste. É uma chamada separada da tela, que continua com a qualidade cheia.
   Quem transmite é o centro da sala: ele conta para todos quem está nela e quem está de câmera ou
   microfone ligado (mensagem av-room); cada um liga direto para os outros. */
'use strict';

const Voice = (() => {
  const isWeb = document.documentElement.classList.contains('web');
  const me = { cam: null, mic: null }; // faixas reais da câmera e do microfone (null = desligado)
  const out = new Map(); // código -> chamada levando a minha câmera/voz
  const tiles = new Map(); // código -> { el, video, call, stream, muted }
  let roster = []; // quem assiste: [{ code, name, cam, mic, voice }] vindo de quem transmite (inclui ele)
  const waiting = []; // chamadas que chegaram antes da lista da sala
  let excluding = false;

  const role = () => (host.stream ? 'host' : watch.code && watch.state === 'watching' ? 'viewer' : null);
  const card = () => (role() === 'viewer' ? $('watch') : $('host')).querySelector('[data-dock="voice"]');
  const cards = () => [...document.querySelectorAll('[data-dock="voice"]')];

  // Quem está na sala e entende câmera/voz (versões antigas do app não recebem estas chamadas)
  function members() {
    if (role() === 'host') return [...host.viewers].filter(([, v]) => v.av).map(([c]) => c);
    if (role() === 'viewer') return roster.filter((p) => p.voice && p.code !== myCode).map((p) => p.code);
    return [];
  }
  function info(code) {
    if (code === myCode) return { name: myName(), cam: !!me.cam, mic: !!me.mic };
    if (role() === 'host') {
      const v = host.viewers.get(code);
      return { name: v?.name || friendName(code), cam: !!v?.av?.cam, mic: !!v?.av?.mic };
    }
    const p = roster.find((r) => r.code === code);
    return { name: p?.name || friendName(code), cam: !!p?.cam, mic: !!p?.mic };
  }

  // ---------------------------------------------------------------- faixas vazias
  // A chamada sempre leva uma faixa de vídeo e uma de áudio; com a câmera ou o microfone desligado vai
  // uma faixa vazia (preta, 1 quadro por segundo; silêncio), e ligar depois só troca a faixa.
  let blank = null;
  function blanks() {
    if (blank && blank.v.readyState === 'live') return blank;
    const c = Object.assign(document.createElement('canvas'), { width: 16, height: 9 });
    c.getContext('2d').fillRect(0, 0, 16, 9);
    const v = c.captureStream(1).getVideoTracks()[0];
    const a = audioCtx().createMediaStreamDestination().stream.getAudioTracks()[0];
    blank = { v, a };
    return blank;
  }
  let actx = null;
  function audioCtx() {
    if (!actx) actx = new AudioContext();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  // ---------------------------------------------------------------- dispositivos
  const DEV = { cam: 'camDevice', mic: 'micDevice' };
  async function listDevices() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
    for (const [kind, id] of Object.entries(DEV)) {
      const sel = $(id);
      if (!sel) continue;
      const want = store(`telinha.${id}`) || '';
      const list = devs.filter((d) => d.kind === (kind === 'cam' ? 'videoinput' : 'audioinput'));
      sel.replaceChildren(new Option('Padrão do sistema', ''), ...list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) =>
        new Option(d.label || `${kind === 'cam' ? 'Câmera' : 'Microfone'} ${i + 1}`, d.deviceId)));
      sel.value = [...sel.options].some((o) => o.value === want) ? want : '';
    }
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
  for (const [kind, id] of Object.entries(DEV)) {
    $(id)?.addEventListener('change', async () => {
      store(`telinha.${id}`, $(id).value);
      if (kind === 'cam') markCamRes();
      if (me[kind]) {
        await setOn(kind, false, true);
        await setOn(kind, true);
      }
    });
  }
  listDevices();
  setTimeout(() => markCamRes(), 0); // depois de montar a lista

  // Resolução da câmera (Configurações): cada pessoa da sala recebe uma cópia, então o bitrate sobe junto
  const CAM_RES = { 360: [640, 360, 600], 480: [854, 480, 900], 720: [1280, 720, 1500], 1080: [1920, 1080, 2500] };
  const camRes = () => CAM_RES[store('telinha.camRes')] || CAM_RES[360];
  // A câmera diz a maior resolução que entrega (getCapabilities, depois da primeira vez que liga): as opções acima
  // disso ficam desligadas na lista. Guardado por aparelho.
  const camKey = () => `telinha.camMax.${store(`telinha.${DEV.cam}`) || 'padrao'}`;
  function markCamRes() {
    const sel = $('camRes');
    if (!sel) return;
    const max = Number(store(camKey())) || 0;
    for (const o of sel.options) {
      const over = max && Number(o.value) > max;
      o.disabled = !!over;
      o.textContent = o.textContent.replace(/ · sua câmera não chega$/, '') + (over ? ' · sua câmera não chega' : '');
    }
    if (max && Number(sel.value) > max) {
      const best = [...sel.options].filter((o) => !o.disabled).at(-1);
      if (best) { sel.value = best.value; store('telinha.camRes', best.value); }
    }
  }
  function learnCam(track) {
    const h = track.getCapabilities?.().height?.max;
    if (!h) return;
    store(camKey(), String(h));
    markCamRes();
  }
  if ($('camRes')) {
    $('camRes').value = CAM_RES[store('telinha.camRes')] ? store('telinha.camRes') : '360';
    $('camRes').addEventListener('change', async () => {
      store('telinha.camRes', $('camRes').value);
      if (me.cam) {
        await setOn('cam', false, true);
        await setOn('cam', true);
      }
    });
  }

  function constraints(kind) {
    const deviceId = store(`telinha.${DEV[kind]}`) || undefined;
    if (kind === 'cam') {
      const [width, height] = camRes();
      return { video: { deviceId: deviceId && { exact: deviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 } } };
    }
    return { audio: { deviceId: deviceId && { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  }

  // ---------------------------------------------------------------- volume do seu microfone
  // A voz passa por um ganho (WebAudio) antes de ir para a sala: 0% a 200%, com um medidor nas Configurações
  const micGain = () => Math.min(200, Math.max(0, Number(store('telinha.micGain') ?? 100))) / 100;
  let gainChain = null; // { raw, src, gain, an, buf }
  function withGain(raw) {
    const ctx = audioCtx();
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    const gain = ctx.createGain();
    gain.gain.value = micGain();
    const dest = ctx.createMediaStreamDestination();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(gain);
    gain.connect(dest);
    gain.connect(an);
    gainChain = { raw, src, gain, an, buf: new Uint8Array(an.fftSize) };
    return dest.stream.getAudioTracks()[0];
  }
  function dropGain() {
    if (!gainChain) return;
    gainChain.raw.stop();
    gainChain.src.disconnect();
    gainChain = null;
  }
  if ($('micGain')) {
    const show = () => { $('micGainLabel').textContent = `${$('micGain').value}%`; };
    $('micGain').value = String(Math.round(micGain() * 100));
    show();
    $('micGain').addEventListener('input', () => {
      store('telinha.micGain', $('micGain').value);
      show();
      if (gainChain) gainChain.gain.gain.value = micGain();
    });
  }
  // Medidor do seu microfone (o que sai depois do ganho): sobe na hora e desce devagar, para dar para ler
  let meterLevel = 0;
  setInterval(() => {
    const bar = $('micMeter');
    if (!bar) return;
    let level = 0;
    if (gainChain) {
      gainChain.an.getByteTimeDomainData(gainChain.buf);
      let peak = 0;
      for (const x of gainChain.buf) peak = Math.max(peak, Math.abs(x - 128));
      level = Math.min(1, peak / 128);
    }
    meterLevel = level = Math.max(level, meterLevel * 0.82 < 0.01 ? 0 : meterLevel * 0.82);
    bar.style.width = `${Math.round(level * 100)}%`;
    bar.classList.toggle('hot', level > 0.95);
    bar.parentElement.classList.toggle('idle', !gainChain);
  }, 100);

  // ---------------------------------------------------------------- ligar e desligar
  const busy = {}; // pedido ao sistema em andamento: um clique duplo não abre a câmera duas vezes
  async function setOn(kind, on, quiet = false) {
    if (busy[kind]) return;
    if (on && !role()) {
      toast(isWeb ? 'Entre numa transmissão para ligar a câmera ou o microfone.' : 'Comece uma transmissão ou entre numa para ligar a câmera ou o microfone.', true);
      return;
    }
    if (on && !me[kind]) {
      audioCtx();
      let track;
      busy[kind] = true;
      try {
        const s = await navigator.mediaDevices.getUserMedia(constraints(kind));
        track = kind === 'cam' ? s.getVideoTracks()[0] : s.getAudioTracks()[0];
      } catch (err) {
        const what = kind === 'cam' ? 'a câmera' : 'o microfone';
        const why = err?.name === 'NotAllowedError' ? ` Libere ${what} para o Telinha${isWeb ? ' no navegador' : ' em Configurações do Windows › Privacidade'}.`
          : err?.name === 'NotReadableError' ? ' Outro programa pode estar usando.'
            : err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError' ? ' Não achei nenhum.' : '';
        toast(`Não deu para ligar ${what}.${why}`, true);
        return;
      } finally {
        busy[kind] = false;
      }
      if (kind === 'cam') {
        track.contentHint = 'motion';
        learnCam(track);
      }
      // A câmera foi desconectada ou o sistema tirou a permissão
      const raw = track;
      if (kind === 'mic') track = withGain(raw);
      raw.addEventListener('ended', () => { if (me[kind] === track) setOn(kind, false); });
      me[kind] = track;
      listDevices(); // agora com os nomes, que só aparecem depois da permissão
    } else if (!on && me[kind]) {
      me[kind].stop();
      if (kind === 'mic') dropGain();
      me[kind] = null;
    } else return;
    await swapTracks();
    if (!quiet) afterChange();
  }

  function afterChange() {
    if (me.cam || me.mic) publish();
    else unpublish();
    announce();
    render();
  }

  async function swapTracks() {
    const b = blanks();
    for (const call of out.values()) {
      for (const s of call.peerConnection?.getSenders() || []) {
        if (s.track?.kind === 'video') await s.replaceTrack(me.cam || b.v).catch(() => {});
        else if (s.track?.kind === 'audio') await s.replaceTrack(me.mic || b.a).catch(() => {});
      }
    }
  }

  // Conta o meu estado: para quem transmite (que repassa) ou, se eu transmito, para todos
  function announce() {
    if (role() === 'viewer') send(watch.code, { t: 'av', cam: !!me.cam, mic: !!me.mic });
    else if (role() === 'host') shareRoster();
  }

  // ---------------------------------------------------------------- mandar a minha câmera/voz
  function publish() {
    if (!(me.cam || me.mic) || !net.peer?.open) return;
    const want = new Set(members());
    for (const code of want) if (!out.has(code)) callTo(code);
    for (const [code, call] of out) if (!want.has(code)) { out.delete(code); try { call.close(); } catch {} }
  }

  function unpublish() {
    for (const call of out.values()) try { call.close(); } catch {}
    out.clear();
  }

  function callTo(code) {
    const b = blanks();
    const stream = new MediaStream([me.cam || b.v, me.mic || b.a]);
    const call = net.peer.call(peerIdFor(code), stream, { metadata: { kind: 'cam' } });
    if (!call) return;
    out.set(code, call);
    const pc = call.peerConnection;
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') tune(pc);
      if (pc.connectionState === 'failed' && out.get(code) === call) {
        out.delete(code);
        try { call.close(); } catch {}
      }
    });
    const gone = () => { if (out.get(code) === call) out.delete(code); };
    call.on('close', gone);
    call.on('error', gone);
  }

  // Cada pessoa da sala recebe uma cópia da câmera. Sala cheia = câmera com metade da resolução.
  async function tune(pc) {
    const crowd = members().length > 5;
    const kbps = camRes()[2];
    for (const s of pc.getSenders()) {
      if (!s.track) continue;
      const p = s.getParameters();
      if (!p.encodings?.length) continue;
      const e = p.encodings[0];
      if (s.track.kind === 'video') {
        e.maxBitrate = (crowd ? kbps / 2.5 : kbps) * 1000;
        e.maxFramerate = 30;
        e.scaleResolutionDownBy = crowd ? 2 : 1;
      } else {
        e.maxBitrate = 48_000;
        e.priority = 'high';
        e.networkPriority = 'high';
      }
      try { await s.setParameters(p); } catch {}
    }
  }
  const retune = () => { for (const c of out.values()) if (c.peerConnection?.connectionState === 'connected') tune(c.peerConnection); };

  // ---------------------------------------------------------------- receber a câmera/voz dos outros
  const isMember = (code) => code !== myCode && (role() === 'host' ? host.viewers.has(code) : role() === 'viewer' && roster.some((p) => p.code === code));

  function onIncoming(call) {
    const code = codeOfPeer(call.peer);
    if (!code) return call.close();
    if (isMember(code)) return accept(call, code);
    // Quem acabou de entrar pode ligar antes de a lista da sala chegar aqui
    waiting.push({ call, code });
    setTimeout(() => {
      const i = waiting.findIndex((w) => w.call === call);
      if (i >= 0) { waiting.splice(i, 1); call.close(); }
    }, 8000);
  }

  function retryWaiting() {
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (!isMember(waiting[i].code)) continue;
      const w = waiting.splice(i, 1)[0];
      accept(w.call, w.code);
    }
  }

  function accept(call, code) {
    const t = tile(code);
    // A chamada nova entra antes de fechar a antiga: o "close" da antiga não pode derrubar o quadradinho
    const old = t.call;
    t.call = call;
    if (old && old !== call) try { old.close(); } catch {}
    call.answer(undefined);
    call.on('stream', (stream) => {
      t.stream = stream;
      // A voz toca num <audio> próprio: com a câmera desligada a faixa de vídeo é vazia (não chega quadro), e um
      // <video> sem quadro não começa a tocar, nem o som. Vídeo e voz continuam sincronizados pelo WebRTC.
      t.video.srcObject = stream;
      t.video.play().catch(() => {});
      t.audio.srcObject = new MediaStream(stream.getAudioTracks());
      t.audio.muted = t.muted;
      t.audio.play().catch((err) => {
        if (err?.name !== 'NotAllowedError') return;
        // Navegador que bloqueia som sem um toque: o botão "Tocar som" do Assistir libera
        $('unmuteBtn').classList.remove('hidden');
      });
      meter(t, stream.getAudioTracks()[0]);
      render();
    });
    const drop = () => { if (tiles.get(code)?.call === call) dropTile(code); };
    call.on('close', drop);
    call.on('error', drop);
    call.peerConnection?.addEventListener('connectionstatechange', () => {
      if (call.peerConnection.connectionState === 'failed') drop();
    });
    render();
  }

  // ---------------------------------------------------------------- quadradinhos
  const MIC_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/></svg>';

  const volOf = (code) => {
    const v = Number((storeJson('telinha.voiceVol') || {})[code]);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
  };

  function tile(code) {
    let t = tiles.get(code);
    if (t) return t;
    const el = document.createElement('div');
    el.className = `voiceTile${code === myCode ? ' me' : ''}`;
    el.dataset.code = code;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // o som vai pelo <audio> abaixo
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.volume = volOf(code) / 100;
    const avatar = document.createElement('div');
    avatar.className = 'voiceAvatar';
    const label = document.createElement('div');
    label.className = 'voiceName';
    const name = document.createElement('span');
    const micOff = document.createElement('span');
    micOff.className = 'voiceMicOff';
    micOff.innerHTML = MIC_OFF;
    label.append(micOff, name);
    el.append(video, audio, avatar, label);
    if (code !== myCode) {
      // Volume desta pessoa só para você (fica salvo), e o botão de silenciar
      const box = document.createElement('div');
      box.className = 'voiceVol';
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'voiceMute';
      mute.addEventListener('click', () => {
        t.muted = !t.muted;
        t.audio.muted = t.muted;
        render();
      });
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '100';
      vol.value = String(volOf(code));
      vol.addEventListener('input', () => {
        t.audio.volume = Number(vol.value) / 100;
        const all = storeJson('telinha.voiceVol') || {};
        all[code] = Number(vol.value);
        storeJson('telinha.voiceVol', all);
        vol.title = `Volume: ${vol.value}%`;
      });
      vol.title = `Volume: ${vol.value}%`;
      box.append(mute, vol);
      el.append(box);
    }
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('button, input')) focusCam(code); }); // abre a câmera grande
    // Aumentar: a câmera abre grande por cima do vídeo principal (dá para redimensionar pelo canto)
    const big = document.createElement('button');
    big.type = 'button';
    big.className = 'voiceBig';
    big.textContent = '⤢';
    big.title = 'Aumentar esta câmera';
    big.setAttribute('aria-label', 'Aumentar esta câmera');
    big.addEventListener('click', () => focusCam(code));
    el.append(big);
    t = { el, video, audio, name, avatar, call: null, stream: null, muted: false, an: null, loudAt: 0 };
    tiles.set(code, t);
    return t;
  }

  // ---------------------------------------------------------------- câmeras aumentadas
  // Cada câmera pode abrir numa janelinha por cima do vídeo, quantas quiser ao mesmo tempo:
  // arrasta pela barra de cima, redimensiona pelo canto, fecha no ✕ (Esc fecha a última).
  // Aberta, ela sai do palco (não faz sentido a mesma câmera duas vezes); lugar e tamanho ficam salvos por pessoa.
  const pops = new Map(); // código -> janelinha
  const popSaved = () => storeJson('telinha.camPops') || {};
  function savePop(code, p) {
    const w = p.parentElement?.getBoundingClientRect(), r = p.getBoundingClientRect();
    if (!w?.width || !r.width) return;
    const all = popSaved();
    all[code] = { x: (r.left - w.left) / w.width, y: (r.top - w.top) / w.height, w: r.width / w.width };
    storeJson('telinha.camPops', all);
  }
  function popFor(code) {
    let p = pops.get(code);
    if (p) return p;
    p = document.createElement('div');
    p.className = 'camStage';
    p.innerHTML = '<video autoplay playsinline muted></video><div class="camStageBar"><span></span><button type="button" title="Fechar (Esc)" aria-label="Fechar a câmera aumentada">✕</button></div>';
    p.querySelector('button').addEventListener('click', () => focusCam(code));
    const bar = p.querySelector('.camStageBar');
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = p.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId);
      p.parentElement?.append(p); // a que você mexe fica por cima das outras
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const w = p.parentElement.getBoundingClientRect(), r = p.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - drag.dx - w.left), w.width - r.width);
      const y = Math.min(Math.max(0, e.clientY - drag.dy - w.top), w.height - r.height);
      Object.assign(p.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      savePop(code, p);
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    // Redimensionou pelo canto: guarda o tamanho novo (depois de parar de mexer)
    let sized = 0;
    let first = true;
    new ResizeObserver(() => {
      if (first) { first = false; return; } // a primeira medida é a da abertura, não uma mudança
      clearTimeout(sized);
      sized = setTimeout(() => { if (p.isConnected) savePop(code, p); }, 400);
    }).observe(p);
    p.addEventListener('dblclick', () => p.querySelector('video').requestFullscreen?.().catch(() => {}));
    const at = popSaved()[code];
    if (at) {
      // Onde estava da última vez (em proporção do palco, para valer em outra janela ou tela)
      Object.assign(p.style, { left: `${at.x * 100}%`, top: `${at.y * 100}%`, width: `${at.w * 100}%`, right: 'auto', bottom: 'auto' });
    } else {
      // Uma em cima da outra, não: abrem lado a lado, três por fileira
      const k = pops.size;
      Object.assign(p.style, { right: `calc(16px + ${(k % 3) * 33}%)`, bottom: `calc(16px + ${Math.floor(k / 3) * 36}%)` });
    }
    pops.set(code, p);
    return p;
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pops.size && !e.target.closest?.('input, textarea, select')) focusCam([...pops.keys()].pop());
  });
  const mainWrap = () => (role() === 'viewer' ? $('remote') : $('preview')).closest('.videoWrap');
  // Abre ou fecha a câmera desta pessoa
  function focusCam(code) {
    if (pops.has(code)) closePop(code);
    else if (tiles.has(code)) popFor(code);
    render();
  }
  function closePop(code) {
    const p = pops.get(code);
    if (!p) return;
    p.querySelector('video').srcObject = null;
    p.remove();
    pops.delete(code);
  }
  function refreshPops() {
    const wrap = mainWrap();
    for (const [code, p] of pops) {
      const t = tiles.get(code);
      if (!t) { closePop(code); continue; }
      const v = p.querySelector('video');
      if (v.srcObject !== t.video.srcObject) v.srcObject = t.video.srcObject; // a mesma: recarregar faria piscar
      v.classList.toggle('mirror', code === myCode);
      p.querySelector('span').textContent = info(code).name;
      p.classList.toggle('camOff', !info(code).cam);
      if (p.parentElement !== wrap) wrap.append(p);
      v.play().catch(() => {});
    }
    for (const [c, t] of tiles) t.el.classList.toggle('focused', pops.has(c));
  }

  // ---------------------------------------------------------------- câmeras no palco
  // No PC as câmeras ficam no próprio palco, no espaço que sobra ao lado do vídeo (a tela é 16:9 e o palco
  // costuma ser mais largo) ou embaixo dele; o vídeo encolhe o necessário para elas terem pelo menos ~1/4
  // do palco (ou o tanto que você arrastou na divisa). Modo conversa: as câmeras ocupam o palco e o vídeo
  // vira um quadro no canto. Quem está sem câmera (só voz, ou nem isso) aparece numa etiqueta pequena.
  const deck = document.createElement('div');
  deck.className = 'camDeck';
  const chipRow = document.createElement('div');
  chipRow.className = 'camChips';
  const chips = new Map(); // código -> etiqueta
  const split = document.createElement('div');
  split.className = 'deckSplit';
  split.title = 'Arraste para mudar o espaço das câmeras (duplo clique volta ao automático)';
  const wide = matchMedia('(min-width: 761px)');
  let talk = false;
  // Onde as câmeras ficam: do lado da tela ou embaixo dela. Você escolhe (botão no card Câmera e voz) e fica
  // salvo; antes o lugar mudava sozinho com o formato da tela e da janela, e as câmeras pulavam de lugar
  let place = store('telinha.deckPlace') === 'below' ? 'below' : 'side';
  let order = []; // ordem das câmeras no palco: quem falou por último vem primeiro
  // Quem está na sala (com ou sem voz): quem transmite + quem assiste
  function people() {
    if (role() === 'host') return [myCode, ...host.viewers.keys()];
    const list = roster.map((p) => p.code);
    return list.length ? list : [watch.code, myCode];
  }
  const onStage = () => wide.matches && !!role() && people().length > 1 && !document.documentElement.classList.contains('immersive');
  function chipFor(code) {
    let c = chips.get(code);
    if (c) return c;
    c = document.createElement('div');
    c.className = 'camChip';
    c.innerHTML = `<span class="voiceAvatar"></span><span class="chipName"></span><span class="chipMic">${MIC_OFF}</span>`;
    chips.set(code, c);
    return c;
  }
  function renderChips(codes) {
    for (const [code, c] of chips) if (!codes.includes(code)) { c.remove(); chips.delete(code); }
    chipRow.replaceChildren(...codes.map((code) => {
      const c = chipFor(code);
      const i = info(code);
      const inVoice = tiles.has(code) && i.mic;
      c.querySelector('.voiceAvatar').textContent = (i.name || '?').trim().charAt(0).toUpperCase();
      c.querySelector('.voiceAvatar').style.setProperty('--who', window.Room?.colorOf(code) || 'var(--accent)');
      c.querySelector('.chipName').textContent = code === myCode ? `${i.name} (você)` : i.name;
      c.classList.toggle('noVoice', !inVoice);
      c.title = inVoice ? `${i.name}: só voz, sem câmera` : `${i.name}: está na sala, sem câmera e sem microfone`;
      return c;
    }));
  }
  const splitSaved = () => storeJson('telinha.deckSplit') || {};
  function layoutDeck() {
    const wrap = mainWrap();
    const v = role() === 'viewer' ? $('remote') : $('preview');
    for (const w of document.querySelectorAll('.videoWrap.hasDeck')) {
      if (w === wrap && onStage()) continue;
      w.classList.remove('hasDeck', 'talk', 'deckSide', 'deckBelow', 'deckChips');
      const wv = w.querySelector(':scope > video');
      if (wv) Object.assign(wv.style, { width: '', height: '', marginRight: '', marginBottom: '' });
    }
    if (!onStage()) { deck.remove(); split.remove(); return; }
    if (deck.parentElement !== wrap) wrap.append(deck);
    if (chipRow.parentElement !== deck) deck.prepend(chipRow);
    // Todas as câmeras ficam no palco (o som de cada pessoa sai do quadro dela, e um <audio> fora da página
    // para de tocar); as sem vídeo e as abertas numa janelinha só ficam escondidas
    const codes = [...tiles.keys()];
    order = [...order.filter((c) => tiles.has(c)), ...codes.filter((c) => !order.includes(c))];
    for (const c of order) if (tiles.get(c).el.parentElement !== deck) deck.append(tiles.get(c).el);
    const cams = order.filter((c) => info(c).cam && !pops.has(c));
    for (const c of order) tiles.get(c).el.classList.toggle('offDeck', !cams.includes(c));
    renderChips(people().filter((c) => !cams.includes(c) && !pops.has(c)));

    const W = wrap.clientWidth, H = wrap.clientHeight;
    const a = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    let mode, dw, dh;
    // Do lado ou embaixo, como você escolheu. Sem câmera nenhuma, só as etiquetas no canto
    const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
    const saved = splitSaved();
    if (!cams.length) { mode = 'deckChips'; dw = W; dh = 0; }
    else if (talk) { mode = 'talk'; dw = W; dh = H; }
    else if (place === 'side') { mode = 'deckSide'; dw = saved.side ? clamp(saved.side * W, W * 0.12, W * 0.7) : clamp(W - H * a, W * 0.3, W * 0.45); dh = H; }
    else { mode = 'deckBelow'; dw = W; dh = saved.below ? clamp(saved.below * H, H * 0.12, H * 0.7) : clamp(H - W / a, H * 0.26, H * 0.45); }
    wrap.classList.add('hasDeck');
    for (const m of ['talk', 'deckSide', 'deckBelow', 'deckChips']) wrap.classList.toggle(m, m === mode);
    wrap.style.setProperty('--deckW', mode === 'deckSide' ? `${dw}px` : '0px');
    wrap.style.setProperty('--deckH', mode === 'deckBelow' ? `${dh}px` : '0px');
    Object.assign(v.style, {
      width: mode === 'deckSide' ? `${W - dw}px` : '', marginRight: mode === 'deckSide' ? `${dw}px` : '',
      height: mode === 'deckBelow' ? `${H - dh}px` : '', marginBottom: mode === 'deckBelow' ? `${dh}px` : '',
    });
    Object.assign(deck.style, { width: mode === 'deckChips' ? '' : `${dw}px`, height: mode === 'deckChips' ? '' : `${dh}px` });
    if (mode === 'deckSide' || mode === 'deckBelow') { if (split.parentElement !== wrap) wrap.append(split); } else split.remove();
    if (mode === 'deckChips') { deck.style.gridTemplateColumns = ''; return; }

    // Grade que deixa as câmeras o maior possível. Com 3 ou mais, quem falou por último ocupa 2x2 quando
    // isso não encolhe a soma das câmeras (numa faixa baixa, todas iguais numa fileira rendem mais)
    const n = cams.length, GAP = 8, PAD = 12, R = 16 / 9;
    const chipH = chipRow.childElementCount ? 44 : 0; // a fileira de etiquetas em cima
    const fit = (lead) => {
      let best = { c: 1, tw: 0, lead, area: 0 };
      for (let c = lead ? 2 : 1; c <= n + (lead ? 3 : 0); c++) {
        const cells = lead ? n + 3 : n;
        const rows = Math.ceil(cells / c);
        const tw = Math.min((dw - PAD * 2 - GAP * (c - 1)) / c, ((dh - chipH - PAD * 2 - GAP * (rows - 1)) / rows) * R);
        if (tw > best.tw) best = { c, tw, lead, area: cells * tw * tw };
      }
      return best;
    };
    const plain = fit(false);
    const led = n >= 3 ? fit(true) : plain;
    const best = led.area > plain.area ? led : plain;
    deck.style.gridTemplateColumns = `repeat(${best.c}, ${Math.max(60, Math.floor(best.tw))}px)`;
    cams.forEach((c, i) => tiles.get(c).el.classList.toggle('lead', best.lead && i === 0));
  }
  // Divisa entre a tela e as câmeras: arrastar muda o espaço (fica salvo); duplo clique volta ao automático
  let splitDrag = null;
  split.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    splitDrag = { id: e.pointerId, side: split.parentElement.classList.contains('deckSide') };
    split.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  split.addEventListener('pointermove', (e) => {
    if (!splitDrag || e.pointerId !== splitDrag.id) return;
    const r = split.parentElement.getBoundingClientRect();
    const all = splitSaved();
    if (splitDrag.side) all.side = Math.min(Math.max((r.right - e.clientX) / r.width, 0.12), 0.7);
    else all.below = Math.min(Math.max((r.bottom - e.clientY) / r.height, 0.12), 0.7);
    storeJson('telinha.deckSplit', all);
    layoutDeck();
  });
  const endSplit = (e) => { if (splitDrag && e.pointerId === splitDrag.id) splitDrag = null; };
  split.addEventListener('pointerup', endSplit);
  split.addEventListener('pointercancel', endSplit);
  split.addEventListener('dblclick', () => {
    const all = splitSaved();
    delete all[split.parentElement.classList.contains('deckSide') ? 'side' : 'below'];
    storeJson('telinha.deckSplit', all);
    layoutDeck();
  });
  // O palco muda de tamanho sem a janela mudar (cartão minimizado, painel recolhido): refaz junto
  const resized = new ResizeObserver(() => layoutDeck());
  for (const w of [$('preview'), $('remote')]) resized.observe(w.closest('.videoWrap'));
  for (const v of [$('preview'), $('remote')]) v.addEventListener('resize', layoutDeck);
  wide.addEventListener('change', () => render());
  // Modo conversa: clicar no vídeo pequeno do canto volta a tela para o palco
  for (const v of [$('preview'), $('remote')]) {
    v.addEventListener('click', () => {
      if (!talk || !v.closest('.videoWrap.talk')) return;
      talk = false;
      render();
    });
  }

  function dropTile(code) {
    const t = tiles.get(code);
    if (!t) return;
    closePop(code);
    tiles.delete(code);
    try { t.call?.close(); } catch {}
    t.an?.src.disconnect();
    t.video.srcObject = null;
    t.audio.srcObject = null;
    t.el.remove();
    render();
  }

  // Quem está falando ganha um contorno. O nível é medido a cada 100 ms e o contorno fica mais meio segundo
  // depois do último som: assim ele não apaga nas pausas entre as sílabas nem antes de a fala terminar
  function meter(t, track) {
    t.an?.src.disconnect();
    t.an = null;
    if (!track) return;
    try {
      const ctx = audioCtx();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      src.connect(node);
      t.an = { src, node, buf: new Uint8Array(node.fftSize) };
    } catch {}
  }
  let reorderedAt = 0;
  setInterval(() => {
    const now = performance.now();
    for (const [code, t] of tiles) {
      if (t.an && info(code).mic) {
        t.an.node.getByteTimeDomainData(t.an.buf);
        let sum = 0;
        for (const x of t.an.buf) sum += (x - 128) ** 2;
        if (Math.sqrt(sum / t.an.buf.length) > 4) t.loudAt = now;
      } else t.loudAt = 0;
      const speaking = now - t.loudAt < 500;
      if (speaking && !t.el.classList.contains('speaking')) t.talkFrom = now;
      t.el.classList.toggle('speaking', speaking);
      chips.get(code)?.classList.toggle('speaking', speaking);
      // Quem fala sobe para o primeiro lugar do palco: depois de 1 s falando, no máximo a cada 3 s
      if (speaking && code !== myCode && order[0] !== code && now - t.talkFrom > 1000 && now - reorderedAt > 3000 && deck.isConnected) {
        order = [code, ...order.filter((c) => c !== code)];
        reorderedAt = now;
        layoutDeck();
      }
    }
  }, 100);

  function render() {
    const r = role();
    // O meu quadradinho: a prévia da minha câmera (espelhada), só enquanto eu mando algo
    if (r && (me.cam || me.mic)) {
      const t = tile(myCode);
      const cam = me.cam || null;
      if ((t.video.srcObject?.getVideoTracks()[0] || null) !== cam) t.video.srcObject = cam ? new MediaStream([cam]) : null;
      if (t.micTrack !== me.mic) { t.micTrack = me.mic; meter(t, me.mic); }
    } else if (tiles.has(myCode)) dropTile(myCode);

    const target = r ? card() : null;
    const staged = onStage();
    for (const c of cards()) {
      const box = c.querySelector('.voiceTiles');
      const mine = c === target;
      const els = mine ? [...tiles.keys()].sort((a, b) => (a === myCode ? -1 : b === myCode ? 1 : 0)).map((code) => {
        const t = tiles.get(code);
        const i = info(code);
        t.name.textContent = code === myCode ? `${i.name} (você)` : i.name;
        t.avatar.textContent = (i.name || '?').trim().charAt(0).toUpperCase();
        t.avatar.style.setProperty('--who', window.Room?.colorOf(code) || 'var(--accent)');
        t.el.classList.toggle('camOff', !i.cam);
        t.el.classList.toggle('micOff', !i.mic);
        t.el.classList.toggle('silenced', !!t.muted);
        const mute = t.el.querySelector('.voiceMute');
        if (mute) {
          mute.textContent = t.muted ? 'Ouvir' : 'Silenciar';
          mute.title = t.muted ? `Voltar a ouvir ${i.name}` : `Silenciar ${i.name} só para você`;
        }
        return t.el;
      }) : [];
      if (staged) box.replaceChildren();
      else box.replaceChildren(...els);
      box.classList.toggle('hidden', staged || !els.length);
      const talkBtn = c.querySelector('.voiceTalkBtn');
      talkBtn.classList.toggle('hidden', !(mine && staged));
      talkBtn.classList.toggle('on', talk);
      talkBtn.setAttribute('aria-pressed', String(talk));
      talkBtn.title = talk ? 'Voltar a tela para o palco' : 'Câmeras grandes no palco e a tela num quadro no canto';
      const placeBtn = c.querySelector('.voicePlaceBtn');
      placeBtn.classList.toggle('hidden', !(mine && staged));
      placeBtn.dataset.place = place;
      placeBtn.querySelector('span').textContent = place === 'side' ? 'Do lado' : 'Embaixo';
      placeBtn.title = place === 'side' ? 'Câmeras do lado da tela (clique para pôr embaixo)' : 'Câmeras embaixo da tela (clique para pôr do lado)';
      const micBtn = c.querySelector('.voiceMicBtn');
      const camBtn = c.querySelector('.voiceCamBtn');
      // O nome fica curto (o painel é estreito); ligado ou não aparece na cor e no título
      for (const [b, on, label] of [[micBtn, !!me.mic, ['Desligar o microfone', 'Ligar o microfone']], [camBtn, !!me.cam, ['Desligar a câmera', 'Ligar a câmera']]]) {
        b.setAttribute('aria-pressed', String(mine && on));
        b.classList.toggle('on', mine && on);
        b.disabled = !mine;
        b.title = label[mine && on ? 0 : 1];
      }
      const others = mine ? [...tiles.keys()].filter((k) => k !== myCode).length : 0;
      c.querySelector('.voiceMeta').textContent = !mine
        ? (c.closest('#host') ? 'Liga quando você estiver ao vivo' : 'Liga quando você estiver assistindo')
        : others ? `${others + (me.cam || me.mic ? 1 : 0)} na conversa` : me.cam || me.mic ? 'Só você por enquanto' : 'Ninguém ligou ainda';
    }
    renderQuick();
    layoutDeck();
    refreshPops();
    checkEcho();
  }

  // ---------------------------------------------------------------- eco
  // Quem transmite manda o som do PC. Se ele ouve a voz dos outros pelo Telinha, essa voz não pode
  // voltar na transmissão: enquanto houver alguém de microfone ligado, a captura tira o próprio Telinha
  // (em vez do Discord, porque o Windows só deixa tirar um programa).
  function checkEcho() {
    const want = role() === 'host' && [...tiles.keys()].some((c) => c !== myCode && info(c).mic);
    if (want === excluding) return;
    excluding = want;
    window.telinha.audioExcludeSelf?.(want);
  }

  // ---------------------------------------------------------------- quem transmite: a lista da sala
  function shareRoster() {
    if (role() !== 'host') return;
    const peers = [{ code: myCode, name: myName(), cam: !!me.cam, mic: !!me.mic, voice: true }];
    for (const [code, v] of host.viewers) peers.push({ code, name: v.name, cam: !!v.av?.cam, mic: !!v.av?.mic, voice: !!v.av });
    for (const code of host.viewers.keys()) send(code, { t: 'av-room', peers });
  }

  function onMessage(code, msg) {
    switch (msg.t) {
      case 'av': {
        // Quem assiste conta o estado dele (e que a versão dele tem câmera/voz)
        const v = host.viewers.get(code);
        if (!v || role() !== 'host') return;
        v.av = { cam: !!msg.cam, mic: !!msg.mic };
        shareRoster();
        publish();
        retune();
        render();
        return;
      }
      case 'av-room': {
        if (code !== watch.code || !Array.isArray(msg.peers)) return;
        roster = msg.peers.slice(0, 60).map((p) => ({
          code: normalizeCode(p?.code), name: String(p?.name || '').slice(0, 24), cam: !!p?.cam, mic: !!p?.mic, voice: !!p?.voice,
        })).filter((p) => p.code);
        for (const c of [...tiles.keys()]) if (c !== myCode && !roster.some((p) => p.code === c)) dropTile(c);
        retryWaiting();
        publish();
        retune();
        render();
        return;
      }
      default:
    }
  }

  // ---------------------------------------------------------------- ciclo de vida (chamado por app.js)
  function reset() {
    unpublish();
    for (const code of [...tiles.keys()]) dropTile(code);
    for (const k of ['cam', 'mic']) if (me[k]) { me[k].stop(); me[k] = null; }
    dropGain();
    roster = [];
    render();
  }
  function onViewerJoin() { shareRoster(); }
  function onViewerLeave(code) {
    const call = out.get(code);
    if (call) { out.delete(code); try { call.close(); } catch {} }
    dropTile(code);
    shareRoster();
    retune();
  }
  // Começou a assistir: conta para quem transmite que esta versão tem câmera/voz
  function onWatchStart() {
    announce();
    render();
  }
  function onHostStart() { render(); }
  function unmuteAll() {
    for (const t of tiles.values()) if (!t.muted) t.audio.play().catch(() => {});
  }

  for (const c of cards()) {
    c.querySelector('.voiceMicBtn').addEventListener('click', () => setOn('mic', !me.mic));
    c.querySelector('.voiceCamBtn').addEventListener('click', () => setOn('cam', !me.cam));
    c.querySelector('.voiceTalkBtn').addEventListener('click', () => { talk = !talk; render(); });
    c.querySelector('.voicePlaceBtn').addEventListener('click', () => {
      place = place === 'side' ? 'below' : 'side';
      store('telinha.deckPlace', place);
      render();
    });
  }
  // Atalhos à mão: na barra de reações do vídeo (Assistir, também em tela cheia) e na caixa Ao vivo
  const ICON = {
    mic: cards()[0].querySelector('.voiceMicBtn svg').outerHTML,
    cam: cards()[0].querySelector('.voiceCamBtn svg').outerHTML,
  };
  const quick = [];
  for (const [place, cls] of [[$('reactBar'), 'reactBtn voiceQuick'], [$('copyInvite'), 'iconBtn voiceQuick']]) {
    if (!place) continue;
    for (const kind of ['mic', 'cam']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.dataset.kind = kind;
      b.innerHTML = ICON[kind];
      b.addEventListener('click', () => setOn(kind, !me[kind]));
      if (place.id === 'copyInvite') place.before(b);
      else place.append(b);
      quick.push(b);
    }
  }
  function renderQuick() {
    for (const b of quick) {
      const on = !!me[b.dataset.kind];
      const label = b.dataset.kind === 'mic' ? (on ? 'Desligar o microfone' : 'Ligar o microfone') : on ? 'Desligar a câmera' : 'Ligar a câmera';
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.title = label;
      b.setAttribute('aria-label', label);
    }
  }
  render();

  return {
    onIncoming, onMessage, onViewerJoin, onViewerLeave, onWatchStart, onHostStart, onStop: reset, unmuteAll,
    excludingSelf: () => excluding, setOn, state: () => ({ cam: !!me.cam, mic: !!me.mic, out: [...out.keys()], tiles: [...tiles.keys()], roster }),
  };
})();
window.Voice = Voice;
