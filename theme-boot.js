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
  } catch {
    root.dataset.theme = 'preto';
  }
})();
