/* Telinha · tecla do microfone: um atalho que liga e desliga o microfone mesmo com o jogo em primeiro plano.
   Liga e desliga, não "segurar para falar": o atalho global do Electron só avisa quando a tecla desce. Como a janela
   pode estar escondida, um bipe curto confirma o que aconteceu. Só no app. */
'use strict';

const Hotkey = (() => {
  const input = $('micKey');
  const load = () => { try { return localStorage.getItem('telinha.micKey') || ''; } catch { return ''; } };
  const save = (v) => { try { localStorage.setItem('telinha.micKey', v); } catch {} };

  // O que o Electron entende, ou null se a tecla não serve: letras e números sozinhos atrapalhariam o que se digita
  function acceleratorOf(e) {
    const { key } = e;
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Escape', 'Tab', 'Dead', 'Unidentified'].includes(key)) return null;
    const fn = /^F([1-9]|1\d|2[0-4])$/.test(key);
    const name = fn ? key : /^[a-z0-9]$/i.test(key) ? key.toUpperCase() : { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete' }[key];
    if (!name) return null;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    if (!fn && !mods.length) return null;
    return [...mods, name].join('+');
  }

  async function set(accel, quiet) {
    const ok = accel ? await window.telinha.micShortcut?.(accel) : (await window.telinha.micShortcut?.(''), true);
    if (!ok) {
      if (!quiet) toast('Essa tecla já está em uso por outro programa. Tente outra.', true);
      input.value = load();
      $('micKeyClear').classList.toggle('hidden', !load());
      return false;
    }
    save(accel);
    input.value = accel;
    $('micKeyClear').classList.toggle('hidden', !accel);
    return true;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Escape') return input.blur();
    if (e.key === 'Backspace') return set('');
    const accel = acceleratorOf(e);
    if (accel) set(accel);
    else if (!['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) toast('Use uma tecla F (F1 a F24) ou combine com Ctrl, Alt ou Shift.', true);
  });
  $('micKeyClear').addEventListener('click', () => set(''));
  set(load(), true);

  // Bipe: agudo ao ligar, grave ao desligar
  function beep(on) {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = on ? 880 : 440;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
      osc.onended = () => ctx.close();
    } catch {}
  }
  async function toggle() {
    const was = Voice.state().mic;
    await Voice.setOn('mic', !was);
    const now = Voice.state().mic;
    if (now !== was) beep(now);
  }
  window.telinha.onMicToggle?.(toggle);

  return { acceleratorOf, toggle, set };
})();
window.Hotkey = Hotkey;
