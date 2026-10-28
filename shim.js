/* Telinha web · substitui a ponte do Electron (preload.js) no navegador.
   No celular o site só assiste. No PC também transmite, pela captura do próprio navegador (sem o som
   do PC sem eco, sem desenhos na tela de verdade e sem atualização automática, que são do app). */
'use strict';
(() => {
  document.documentElement.classList.add('web');
  if (navigator.mediaDevices?.getDisplayMedia && matchMedia('(pointer: fine)').matches) document.documentElement.classList.add('webHost');
  const noop = () => {};
  const ua = navigator.userAgent;
  window.telinha = {
    sources: async () => [],
    choose: async () => {},
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(String(text));
      } catch {
        // Sem permissão de área de transferência: mostra o texto para copiar à mão
        window.prompt('Copie:', String(text));
      }
    },
    paste: async () => {
      try { return await navigator.clipboard.readText(); } catch { return ''; }
    },
    attention: async () => { try { navigator.vibrate?.(80); } catch {} },
    diagInfo: async () => ({
      versions: { electron: '—', chrome: (ua.match(/(?:Chrome|CriOS)\/([\d.]+)/) || ua.match(/Version\/([\d.]+).*Safari/) || [])[1] || '—' },
      appVersion: `web ${window.TELINHA_WEB_VERSION || ''}`.trim(),
      os: /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : navigator.platform || 'navegador',
      gpus: [],
    }),
    openInternals: noop,
    audioStart: async () => ({ ok: false, error: 'indisponível no navegador' }),
    audioStop: noop,
    onPcm: noop,
    onAudioMode: noop,
    onUpdate: noop,
    updateInstall: noop,
    overlayMark: async () => false,
    overlayHide: noop,
    overlayFx: async () => false,
    overlayDraw: async () => false,
    // Convite: o link do Discord traz ?assistir=ABCD-EFGH
    takeInvite: async () => new URLSearchParams(location.search).get('assistir'),
    onInvite: noop,
    discordPresence: async () => 'off',
    onDiscordStatus: noop,
    discordWebhook: async () => ({ ok: false, error: 'indisponível no navegador' }),
  };
})();
