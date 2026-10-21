let ctx; // um único AudioContext compartilhado por todos os medidores
const getCtx = () => (ctx ??= new AudioContext());

/**
 * Chama onChange(true|false) quando a faixa de áudio começa/para de ter fala.
 * Retorna a função que encerra a observação. Não reproduz nada (só mede).
 */
export function watchSpeaking(stream, onChange) {
  const c = getCtx();
  c.resume().catch(() => {});
  const source = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  let speaking = false;
  let holdUntil = 0;
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const now = performance.now();
    if (Math.sqrt(sum / data.length) > 0.02) holdUntil = now + 250; // segura 250 ms: evita piscar
    const next = now < holdUntil;
    if (next !== speaking) onChange((speaking = next));
  }, 80);

  return () => {
    clearInterval(timer);
    source.disconnect();
  };
}
