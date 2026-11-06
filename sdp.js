// Ajustes de SDP aplicados nos dois lados da negociação:
//  - coloca o codec escolhido em primeiro lugar na seção de vídeo
//  - pede ao WebRTC para começar já com bitrate alto (sem a rampa lenta padrão)
//  - libera Opus estéreo em bitrate alto (o padrão é mono ~32 kbps)
(function () {
  const MAX_KBPS = 60000;

  function sections(lines) {
    const idx = [];
    lines.forEach((l, i) => { if (l.startsWith('m=')) idx.push(i); });
    return idx.map((start, n) => ({ start, end: n + 1 < idx.length ? idx[n + 1] : lines.length }));
  }

  function parseSection(lines, { start, end }) {
    const rtpmap = {};
    const fmtp = {};
    const apt = {};
    for (let i = start; i < end; i++) {
      let m = lines[i].match(/^a=rtpmap:(\d+) ([\w-]+)\//);
      if (m) rtpmap[m[1]] = m[2].toUpperCase();
      m = lines[i].match(/^a=fmtp:(\d+) (.*)$/);
      if (m) {
        fmtp[m[1]] = { line: i, value: m[2] };
        const a = m[2].match(/(?:^|;)apt=(\d+)/);
        if (a) apt[m[1]] = a[1];
      }
    }
    return { rtpmap, fmtp, apt };
  }

  // Procura a linha a partir do m= até o próximo m= (o fim da seção muda quando inserimos linhas)
  function findLine(lines, start, prefix) {
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('m='); i++) {
      if (lines[i].startsWith(prefix)) return i;
    }
    return -1;
  }

  function setFmtp(lines, info, pt, extra, rtpmapLine) {
    const f = info.fmtp[pt];
    if (f) {
      const keys = extra.map((kv) => kv.split('=')[0]);
      const kept = f.value.split(';').filter((kv) => kv && !keys.includes(kv.split('=')[0]));
      lines[f.line] = `a=fmtp:${pt} ${[...kept, ...extra].join(';')}`;
    } else {
      lines.splice(rtpmapLine + 1, 0, `a=fmtp:${pt} ${extra.join(';')}`);
    }
  }

  function tuneVideo(lines, sec, codec, kbps) {
    const info = parseSection(lines, sec);
    const mParts = lines[sec.start].split(' ');
    const pts = mParts.slice(3);
    let primary = pts.filter((pt) => info.rtpmap[pt] === codec);
    if (!primary.length) return;
    if (codec === 'H264') {
      // packetization-mode=1 é o que os encoders de hardware usam
      const pm1 = (pt) => /packetization-mode=1/.test(info.fmtp[pt]?.value || '');
      primary = [...primary.filter(pm1), ...primary.filter((pt) => !pm1(pt))];
    }
    const rtx = pts.filter((pt) => info.apt[pt] && primary.includes(info.apt[pt]));
    const rest = pts.filter((pt) => !primary.includes(pt) && !rtx.includes(pt));
    lines[sec.start] = [...mParts.slice(0, 3), ...primary, ...rtx, ...rest].join(' ');

    const start = Math.max(1000, Math.round(kbps));
    const extra = [
      `x-google-start-bitrate=${start}`,
      `x-google-min-bitrate=${Math.round(start * 0.3)}`,
      `x-google-max-bitrate=${MAX_KBPS}`,
    ];
    for (const pt of primary) {
      const rtpmapLine = findLine(lines, sec.start, `a=rtpmap:${pt} `);
      const end = sections(lines).find((s) => s.start === sec.start).end;
      if (rtpmapLine >= 0) setFmtp(lines, parseSection(lines, { start: sec.start, end }), pt, extra, rtpmapLine);
    }
  }

  function tuneAudio(lines, sec) {
    const info = parseSection(lines, sec);
    const pt = Object.keys(info.rtpmap).find((p) => info.rtpmap[p] === 'OPUS');
    if (!pt) return;
    const rtpmapLine = findLine(lines, sec.start, `a=rtpmap:${pt} `);
    if (rtpmapLine < 0) return;
    setFmtp(lines, info, pt, ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=256000', 'useinbandfec=1'], rtpmapLine);
  }

  // opts: { codec: 'H264' | 'AV1' | 'VP9', kbps: number }
  window.tuneSdp = function tuneSdp(sdp, opts) {
    try {
      const lines = sdp.split('\r\n');
      // Recalcula as seções a cada passo porque inserir fmtp muda os índices
      let secs = sections(lines);
      const v = secs.findIndex((s) => lines[s.start].startsWith('m=video'));
      if (v >= 0) tuneVideo(lines, secs[v], opts.codec, opts.kbps);
      secs = sections(lines);
      secs.filter((s) => lines[s.start].startsWith('m=audio')).forEach((s) => tuneAudio(lines, s));
      return lines.join('\r\n');
    } catch (err) {
      console.warn('tuneSdp falhou, usando SDP original', err);
      return sdp;
    }
  };
})();
