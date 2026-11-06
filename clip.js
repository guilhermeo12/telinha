/* Telinha · clipe: guarda o que está no palco e salva os últimos 30 segundos ou um pouco mais.
   Um trecho de .webm só toca desde o início do arquivo, então dois gravadores correm sobrepostos: a cada 30 s nasce
   um novo e o mais velho sai. O mais velho sempre tem de 30 a 60 s, e é ele que vira o clipe. Gasta CPU e memória
   enquanto estiver ligado, por isso é opcional. Só no app. */
'use strict';

const Clip = (() => {
  const cfg = { rotate: 30000 }; // os testes encurtam
  const TYPES = ['video/webm;codecs=h264', 'video/webm;codecs=vp8', 'video/webm'];
  const BITS = 6_000_000;
  let wanted = false;
  try { wanted = localStorage.getItem('telinha.clip') === '1'; } catch {}
  let stream = null;
  let recorders = []; // [{ rec, chunks, at }], do mais velho para o mais novo
  let lastBirth = 0;

  const staged = () => (host.stream ? host.stream : watch.state === 'watching' ? $('remote').srcObject : null);

  function birth() {
    try {
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITS });
      const entry = { rec, chunks: [], at: performance.now() };
      rec.ondataavailable = (e) => { if (e.data.size) entry.chunks.push(e.data); };
      rec.onerror = () => { recorders = recorders.filter((r) => r !== entry); };
      rec.start(1000);
      recorders.push(entry);
      lastBirth = performance.now();
    } catch (err) {
      console.warn('clipe:', err.message);
    }
  }
  function stopAll() {
    for (const { rec } of recorders) { if (rec.state !== 'inactive') try { rec.stop(); } catch {} }
    recorders = [];
    stream = null;
  }

  function tick() {
    const now = wanted ? staged() : null;
    // Sem o que gravar, ou o palco trocou de vídeo (os gravadores antigos ficariam presos no anterior)
    if (now !== stream) stopAll();
    if (!now) return render();
    stream = now;
    if (!recorders.length || performance.now() - lastBirth >= cfg.rotate) {
      birth();
      while (recorders.length > 2) {
        const old = recorders.shift();
        if (old.rec.state !== 'inactive') try { old.rec.stop(); } catch {}
      }
    }
    render();
  }

  // O clipe até agora: o gravador mais velho, com o que ele tiver juntado
  async function build() {
    const entry = recorders[0];
    if (!entry || entry.rec.state === 'inactive') return null;
    entry.rec.requestData();
    await new Promise((r) => setTimeout(r, 150));
    return entry.chunks.length ? new Blob(entry.chunks, { type: 'video/webm' }) : null;
  }
  async function save() {
    const blob = await build();
    if (!blob) return toast('Ainda não tem nada guardado. Espere alguns segundos.', true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `telinha-clipe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    if (watch.code && !host.stream) send(watch.code, { t: 'clip-saved' }); // quem transmite fica sabendo
    toast('Clipe salvo.');
  }

  const toggles = () => document.querySelectorAll('.clipToggle');
  function render() {
    for (const t of toggles()) t.checked = wanted;
    for (const b of document.querySelectorAll('.clipSave')) {
      b.classList.toggle('hidden', !wanted);
      b.disabled = !recorders.length;
    }
  }
  for (const t of toggles()) {
    t.addEventListener('change', () => {
      wanted = t.checked;
      try { localStorage.setItem('telinha.clip', wanted ? '1' : '0'); } catch {}
      tick();
    });
  }
  for (const b of document.querySelectorAll('.clipSave')) b.addEventListener('click', save);
  setInterval(tick, 1000);
  render();

  return {
    cfg, build, save,
    onMessage(code, msg) {
      if (msg.t === 'clip-saved' && host.viewers.has(code)) toast(`${friendName(code)} salvou um clipe da sala.`);
    },
    state: () => ({ wanted, recorders: recorders.length, oldest: recorders[0] ? Math.round((performance.now() - recorders[0].at) / 1000) : 0 }),
  };
})();
window.Clip = Clip;
