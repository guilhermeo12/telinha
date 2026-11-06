// Cor dos temas de vidro: uma cor escolhida gera o fundo sem vídeo e o destaque (links, caixas de seleção), com o
// contraste ajustado para o modo claro ou escuro. Aqui, e não em themes.js, para valer já na primeira pintura.
window.GlassTint = (() => {
  const DEFAULT = '#8b90a0'; // Grafite
  const TOKENS = ['--accent', '--accent-ink', '--accent-soft', '--accent-on', '--link'];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // "#abc", "abc", "#aabbcc" ou "aabbcc" viram "#aabbcc"; qualquer outra coisa, null
  function parse(text) {
    const m = String(text).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    const h = m[1].toLowerCase();
    return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
  }
  function toHsl(hex) {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    if (!d) return { h: 0, s: 0, l: l * 100 };
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s: (d / (1 - Math.abs(2 * l - 1))) * 100, l: l * 100 };
  }
  // Contraste da WCAG entre uma cor em HSL e outra em hex
  function luminance(r, g, b) {
    const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function rgbOf(h, s, l) {
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n) => { const k = (n + h / 30) % 12; return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
  }
  const contrast = (a, b) => {
    const la = luminance(...a), lb = luminance(...b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const BASE = { dark: [0.16, 0.16, 0.19], light: [0.96, 0.96, 0.97] }; // o que costuma estar atrás do texto

  // Preto, branco e cinza não têm matiz: viram o Grafite
  function palette(hex, light) {
    const { h, s } = toHsl(parse(hex) || DEFAULT);
    const neutral = s < 15;
    const sat = neutral ? 8 : clamp(s, 35, 100);
    const base = light ? BASE.light : BASE.dark;
    let l = light ? 40 : 72;
    while (contrast(rgbOf(h, sat, l), base) < 4.5 && l > 5 && l < 97) l += light ? -2 : 2;
    const css = (lum, alpha) => `hsl(${Math.round(h)} ${Math.round(sat)}% ${Math.round(lum)}%${alpha ? ` / ${alpha}` : ''})`;
    return {
      accent: { '--accent': css(l), '--accent-ink': css(clamp(l + (light ? -16 : 12), 5, 96)), '--accent-soft': css(light ? 45 : 62, light ? 0.14 : 0.2), '--accent-on': contrast(rgbOf(h, sat, l), [0, 0, 0]) >= 4.5 ? '#000000' : '#ffffff', '--link': css(l) },
      // As três manchas do fundo sem vídeo: tons vizinhos, com a intensidade limitada para não brigar com o texto
      blobs: { hues: neutral ? [h, h + 20, h - 20] : [h, h + 24, h - 22], sat: neutral ? 10 : clamp(s, 25, 62), light: light ? 72 : neutral ? 42 : 36 },
    };
  }
  const current = () => {
    try { return parse(localStorage.getItem('telinha.glassTint')) || DEFAULT; } catch { return DEFAULT; }
  };
  const isLight = () => matchMedia('(prefers-color-scheme: light)').matches;
  // Acrílico: quanto do que está atrás da janela aparece (100 = tudo, 0 = só a cor do vidro)
  const transparency = () => {
    let v = NaN;
    try { v = Number(localStorage.getItem('telinha.glassTransparency') ?? NaN); } catch {}
    return v >= 0 && v <= 100 ? v : 75;
  };
  // Fora dos vidros, os tokens de cada tema valem como sempre
  function apply() {
    const root = document.documentElement;
    // As miniaturas dos vidros mostram a cor em qualquer tema, para dar para ver antes de escolher
    const { hues, sat, light } = palette(current(), isLight()).blobs;
    for (const mini of document.querySelectorAll('.swatch[data-theme^="vidro"]')) {
      mini.style.setProperty('--mini-a', `hsl(${Math.round(hues[0])} ${sat}% ${light}%)`);
      mini.style.setProperty('--mini-b', `hsl(${Math.round(hues[1])} ${sat}% ${light}%)`);
      mini.style.setProperty('--mini-base', isLight() ? '#dfe3ea' : '#0b0d14');
    }
    if (!(root.dataset.theme || '').startsWith('vidro')) return TOKENS.forEach((t) => root.style.removeProperty(t));
    // O véu do acrílico leva a cor do vidro: lá as manchas do fundo não aparecem. Em qualquer cor o texto continua legível
    let veil = light;
    const text = isLight() ? [0.067, 0.067, 0.078] : [1, 1, 1];
    while (contrast(rgbOf(hues[0], sat, veil), text) < 4.5 && veil > 5 && veil < 97) veil += isLight() ? 2 : -2;
    root.style.setProperty('--glass-veil', `hsl(${Math.round(hues[0])} ${sat}% ${veil}% / ${(100 - transparency()) / 100})`);
    for (const [token, value] of Object.entries(palette(current(), isLight()).accent)) root.style.setProperty(token, value);
  }
  return { DEFAULT, parse, palette, current, apply, transparency, blobs: () => palette(current(), isLight()).blobs, contrast, rgbOf };
})();

// Aplica o tema salvo antes da primeira pintura, para a tela não piscar no tema errado
(() => {
  const root = document.documentElement;
  try {
    root.dataset.theme = localStorage.getItem('telinha.theme') || 'preto';
    if (localStorage.getItem('telinha.reduceTransparency') === '1') root.dataset.reduceTransparency = '1';
    // Aparência dos temas claros: clara (padrão), escura ou a do Windows
    const mode = localStorage.getItem('telinha.mode') || 'light';
    root.dataset.mode = mode === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
    // Barra lateral recolhida: já na primeira pintura, sem animar
    if (localStorage.getItem('telinha.nav') === 'mini') root.dataset.nav = 'mini';
    window.GlassTint.apply();
  } catch {
    root.dataset.theme = 'preto';
  }
})();
