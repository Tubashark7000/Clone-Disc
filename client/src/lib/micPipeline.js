import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

let wasmPromise; // o WASM é baixado uma vez só
const loadWasm = () => (wasmPromise ??= loadRnnoise({ url: wasmUrl, simdUrl }));
// A supressão do navegador fica sempre desligada: ou é a IA (RNNoise) ou nada.
const CONSTRAINTS = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };

// Sem Web Audio: envia a faixa do microfone direto, sem supressão.
function plainPipeline(rawTrack) {
  const p = {
    track: rawTrack,
    mode: "off",
    async setMode() {
      return "off";
    },
    async close() {
      rawTrack.stop();
    },
  };
  return p;
}

/**
 * Microfone -> [RNNoise (IA)] -> faixa enviada ao WebRTC.
 * A faixa de saída é sempre a mesma; trocar o modo só reencaminha o áudio no grafo.
 * Modos: "ai" (RNNoise) e "off".
 *
 * Proteções para nunca deixar a pessoa sem voz:
 *  - se o Web Audio não rodar (contexto suspenso/erro), envia o microfone direto;
 *  - se o RNNoise falhar ou ficar mudo com a entrada ativa, volta sozinho para "off".
 */
export async function createMicPipeline(mode) {
  const raw = await navigator.mediaDevices.getUserMedia({ audio: { ...CONSTRAINTS, channelCount: 1 } });
  const rawTrack = raw.getAudioTracks()[0];
  let ctx;

  try {
    ctx = new AudioContext({ sampleRate: 48000 }); // o RNNoise exige 48 kHz
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    if (ctx.state !== "running") throw new Error("AudioContext não iniciou");

    const source = ctx.createMediaStreamSource(raw);
    const dest = ctx.createMediaStreamDestination();
    const inMeter = ctx.createAnalyser();
    const outMeter = ctx.createAnalyser();
    source.connect(inMeter); // medidores: não vão para a saída

    let rnnoise = null;
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary: await loadWasm(), maxChannels: 1 });
      rnnoise.connect(dest);
      rnnoise.connect(outMeter);
      rnnoise.onprocessorerror = () => fallback();
    } catch (e) {
      console.warn("RNNoise indisponível:", e);
    }

    const pipeline = {
      track: dest.stream.getAudioTracks()[0],
      mode,
      onFallback: null,
      // Retorna o modo realmente aplicado ("ai" cai para "off" se o RNNoise não carregou).
      async setMode(next) {
        const actual = next === "ai" && rnnoise ? "ai" : "off";
        try { source.disconnect(dest); } catch {}
        if (rnnoise) try { source.disconnect(rnnoise); } catch {}
        source.connect(actual === "ai" ? rnnoise : dest);
        pipeline.mode = actual;
        return actual;
      },
      async close() {
        clearInterval(timer);
        rawTrack.stop();
        pipeline.track.stop();
        await ctx.close().catch(() => {});
      },
    };

    function fallback() {
      if (pipeline.mode !== "ai") return;
      pipeline.setMode("off");
      pipeline.onFallback?.("off");
    }

    // Vigia: entrada com som, mas saída exatamente zero por ~4 s = processador travado.
    // (O RNNoise normal, mesmo silenciando ruído, deixa um resíduo diferente de zero.)
    const buf = new Float32Array(inMeter.fftSize);
    const rms = (a) => {
      a.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      return Math.sqrt(s / buf.length);
    };
    let dead = 0;
    const timer = setInterval(() => {
      if (pipeline.mode !== "ai") return void (dead = 0);
      dead = rms(inMeter) > 0.01 && rms(outMeter) < 1e-7 ? dead + 1 : 0;
      if (dead >= 8) fallback();
    }, 500);

    await pipeline.setMode(mode);
    return pipeline;
  } catch (e) {
    console.warn("Web Audio indisponível; enviando o microfone direto:", e);
    ctx?.close().catch(() => {});
    return plainPipeline(rawTrack);
  }
}
