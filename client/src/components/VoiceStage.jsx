import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, Copy, Link2, Maximize, Mic, MicOff, Minimize, MonitorUp, PhoneOff, RefreshCw, SlidersHorizontal, Video, VideoOff } from "lucide-react";
import Avatar from "../lib/Avatar";
import { BITRATES } from "../hooks/useVoice";
import { copyText } from "../lib/clipboard";
import { hardReload } from "../lib/refresh";
import { watchSpeaking } from "../lib/voiceActivity";

const GAP = 12;
const MAX_W = 960;

// Calcula o maior tamanho 16:9 que permite encaixar n quadros na área, em qualquer número de colunas.
function fit(n, W, H) {
  let best = 0;
  for (let cols = 1; cols <= Math.max(n, 1); cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - GAP * (cols - 1)) / cols, ((H - GAP * (rows - 1)) / rows) * (16 / 9));
    best = Math.max(best, w);
  }
  const w = Math.max(0, Math.min(Math.floor(best), MAX_W));
  return { w, h: Math.round((w * 9) / 16) };
}

function useArea(ref) {
  const [area, setArea] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return area;
}

const BOX = {
  grid: "relative rounded-xl bg-rail",
  focus: "absolute inset-0 z-10 bg-black",
  // fora de foco o quadro continua montado (o <video> reproduz o áudio do participante)
  away: "pointer-events-none absolute size-px opacity-0",
};

function ScreenBadge({ self }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 text-center">
      <MonitorUp size={56} className="text-live" />
      <span className="text-sm text-muted">{self ? "Você está compartilhando a tela" : "Conectando à tela…"}</span>
    </div>
  );
}

function Tile({ stream, mic, name, kind, local, muted, mode, size, onToggleFull }) {
  const ref = useRef(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!mic) return setSpeaking(false);
    return watchSpeaking(mic, setSpeaking);
  }, [mic]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream ?? null;
    if (!stream) return setHasVideo(false);
    const update = () => setHasVideo(stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted));
    const bind = () => {
      stream.getTracks().forEach((t) => ((t.onmute = update), (t.onunmute = update), (t.onended = update)));
      update();
    };
    bind();
    stream.addEventListener("addtrack", bind);
    return () => stream.removeEventListener("addtrack", bind);
  }, [stream]);

  // Quem compartilha não vê a própria tela (evita o efeito espelho): vê um ícone de tela.
  const sharingSelf = local && kind === "screen";
  const showVideo = hasVideo && !sharingSelf;
  const fitMode = mode === "focus" || kind === "screen" ? "object-contain" : "object-cover";

  return (
    <figure
      style={mode === "grid" ? { width: size.w, height: size.h } : undefined}
      className={`${BOX[mode]} grid place-items-center overflow-hidden transition-shadow ${speaking && mode === "grid" ? "ring-2 ring-live" : ""}`}
    >
      {/* o vídeo preenche o quadro por posicionamento absoluto; object-contain mostra a tela inteira */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={local}
        className={showVideo ? `absolute inset-0 h-full w-full ${fitMode}` : "absolute size-px opacity-0"}
      />
      {!showVideo &&
        (kind === "screen" ? (
          <ScreenBadge self={local} />
        ) : (
          <div
            className={`rounded-full transition duration-150 ${
              speaking ? "scale-105 ring-4 ring-live ring-offset-4 ring-offset-rail" : ""
            }`}
          >
            <Avatar name={name} size={Math.min(96, Math.max(40, Math.round(size.h * 0.3)))} />
          </div>
        ))}
      <figcaption className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-sm">
        {name}
        {local && " (você)"}
        {kind === "screen" && " · tela"}
        {muted && <MicOff size={14} className="ml-1.5 inline text-danger" aria-label="Microfone silenciado" />}
      </figcaption>
      {onToggleFull && (
        <button
          onClick={onToggleFull}
          title={mode === "focus" ? "Sair da tela cheia" : "Tela cheia"}
          className="absolute right-2 top-2 z-20 rounded bg-black/60 p-2 hover:bg-black/80"
        >
          {mode === "focus" ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      )}
    </figure>
  );
}

function Btn({ onClick, active, danger, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-full p-3.5 ${
        danger ? "bg-danger text-white hover:brightness-110" : active ? "bg-ink text-rail" : "bg-field hover:bg-field/70"
      }`}
    >
      {children}
    </button>
  );
}

const NOISE_OPTIONS = [
  ["ai", "Ligada (IA)", "RNNoise: remove teclado, ventilador e ruído de fundo"],
  ["off", "Desligada", "Áudio original do microfone"],
];

function NoiseMenu({ mode, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Btn onClick={() => setOpen((o) => !o)} active={mode !== "off"} title="Supressão de ruído">
        <AudioLines size={22} />
      </Btn>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-1/2 z-40 mb-2 w-64 -translate-x-1/2 rounded-lg bg-side p-1 shadow-lg ring-1 ring-line">
            <p className="px-3 py-2 text-xs font-medium text-muted">Supressão de ruído</p>
            {NOISE_OPTIONS.map(([value, label, hint]) => (
              <button
                key={value}
                onClick={() => (onChange(value), setOpen(false))}
                className="flex w-full flex-col rounded px-3 py-2 text-left text-sm hover:bg-field"
              >
                <span className="flex items-center justify-between">
                  {label}
                  {mode === value && <Check size={16} className="text-live" />}
                </span>
                <span className="text-xs text-muted">{hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const RES_OPTIONS = [[720, "720p"], [1080, "1080p"]];
const FPS_OPTIONS = [[30, "30 fps"], [60, "60 fps"]];
const BITRATE_OPTIONS = [
  ["low", "Baixo", "700 kbps"],
  ["medium", "Médio", "2 Mbps"],
  ["high", "Alto", "4 Mbps"],
  ["ultra", "Ultra", "8 Mbps"],
];

function Seg({ label, value, options, onChange }) {
  return (
    <div className="px-3 py-2">
      <p className="pb-1 text-xs font-medium text-muted">{label}</p>
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-rail p-1">
        {options.map(([v, text, sub]) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`rounded-md px-2 py-1.5 text-sm ${value === v ? "bg-accent text-white" : "hover:bg-field"}`}
          >
            {text}
            {sub && <span className="block text-[10px] opacity-70">{sub}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScreenQualityMenu({ quality, onChange, viewers }) {
  const [open, setOpen] = useState(false);
  const heavy = quality.res === 1080 && quality.fps === 60 && (quality.bitrate === "low" || quality.bitrate === "medium");
  const upload = ((viewers * BITRATES[quality.bitrate]) / 1_000_000).toFixed(1);
  return (
    <div className="relative">
      <Btn onClick={() => setOpen((o) => !o)} title="Qualidade do compartilhamento de tela">
        <SlidersHorizontal size={22} />
      </Btn>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-1/2 z-40 mb-2 w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-side p-1 shadow-lg ring-1 ring-line">
            <p className="px-3 py-2 text-xs font-medium text-muted">Qualidade do compartilhamento de tela</p>
            <Seg label="Resolução" value={quality.res} options={RES_OPTIONS} onChange={(res) => onChange({ res })} />
            <Seg label="Taxa de quadros" value={quality.fps} options={FPS_OPTIONS} onChange={(fps) => onChange({ fps })} />
            <Seg label="Bitrate" value={quality.bitrate} options={BITRATE_OPTIONS} onChange={(bitrate) => onChange({ bitrate })} />
            <div className="space-y-1 px-3 py-2 text-xs text-muted">
              {heavy && <p className="text-danger">1080p a 60 fps pede bitrate Alto ou Ultra para ficar nítido.</p>}
              {viewers > 0 && <p>Cada pessoa recebe uma cópia: upload estimado de até {upload} Mbps.</p>}
              <p>As mudanças valem na hora, mesmo durante o compartilhamento.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function VoiceStage({ voice, me }) {
  const rootRef = useRef(null);
  const areaRef = useRef(null);
  const area = useArea(areaRef);
  const [focusId, setFocusId] = useState(null);
  const [copied, setCopied] = useState(null); // "code" | "link" | "fail" | null

  const tiles = voice.participants.map((p) => ({
    ...p,
    local: p.id === me?.id,
    stream: p.id === me?.id ? voice.preview : voice.remotes[p.id],
  }));
  const focused = tiles.find((t) => t.id === focusId && t.video === "screen" && !t.local);
  const size = fit(tiles.length, area.w, area.h);

  // Tela cheia no contêiner inteiro (não só no <video>) para manter a barra de controles visível.
  const enter = (id) => {
    setFocusId(id);
    Promise.resolve(rootRef.current?.requestFullscreen?.()).catch(() => {});
  };
  const exit = () => {
    setFocusId(null);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
    const onChange = () => !document.fullscreenElement && setFocusId(null); // ESC
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (focusId && !focused) exit(); // quem compartilhava parou ou saiu
  }, [focusId, focused]);

  const copy = async (what) => {
    const text = what === "link" ? `${location.origin}${location.pathname}?sala=${voice.roomCode}` : voice.roomCode;
    setCopied((await copyText(text)) ? what : "fail");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div ref={rootRef} className="flex h-dvh flex-col bg-main">
      {!focused && (
        <header className="flex items-center justify-center gap-3 border-b border-line px-4 py-3">
          <span className="text-sm text-muted">Sala</span>
          <code className="text-lg font-semibold tracking-widest">{voice.roomCode}</code>
          <button onClick={() => copy("code")} title="Copiar código" className="rounded p-1.5 text-muted hover:bg-field hover:text-ink">
            {copied === "code" ? <Check size={18} className="text-live" /> : <Copy size={18} />}
          </button>
          <button onClick={() => copy("link")} title="Copiar link da sala" className="rounded p-1.5 text-muted hover:bg-field hover:text-ink">
            {copied === "link" ? <Check size={18} className="text-live" /> : <Link2 size={18} />}
          </button>
          {copied === "fail" && <span className="text-xs text-danger">Não foi possível copiar</span>}
          <button
            onClick={() => hardReload(true)}
            title="Atualizar do zero (limpa o cache, recarrega e volta para a sala)"
            className="rounded p-1.5 text-muted hover:bg-field hover:text-ink"
          >
            <RefreshCw size={18} />
          </button>
          {voice.muted && (
            <span className="flex items-center gap-1.5 rounded-full bg-danger/20 px-3 py-1 text-xs font-medium text-danger">
              <MicOff size={14} /> Microfone silenciado
            </span>
          )}
        </header>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={areaRef}
          className={
            focused
              ? "absolute inset-0"
              : "absolute inset-4 flex flex-wrap content-center items-center justify-center gap-3"
          }
        >
          {tiles.map((t) => {
            const mode = !focused ? "grid" : t.id === focused.id ? "focus" : "away";
            // só quem assiste vê o botão de tela cheia; o dono do compartilhamento não
            const canFull = t.video === "screen" && !t.local;
            return (
              <Tile
                key={t.id}
                stream={t.stream}
                name={t.name}
                kind={t.video}
                local={t.local}
                muted={t.local && voice.muted}
                mic={t.local ? voice.localMic : voice.mics[t.id]}
                mode={mode}
                size={size}
                onToggleFull={canFull ? () => (mode === "focus" ? exit() : enter(t.id)) : undefined}
              />
            );
          })}
        </div>
      </div>

      {voice.error && <p className="text-center text-sm text-danger">{voice.error}</p>}
      {voice.notice && <p className="px-4 text-center text-sm text-muted">{voice.notice}</p>}

      <div className="flex justify-center gap-3 p-4">
        <Btn onClick={voice.toggleMute} active={voice.muted} title={voice.muted ? "Ativar microfone" : "Silenciar microfone"}>
          {voice.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </Btn>
        <NoiseMenu mode={voice.noiseMode} onChange={voice.setNoiseMode} />
        <Btn onClick={() => voice.setVideo(voice.videoKind === "camera" ? null : "camera")} active={voice.videoKind === "camera"} title="Câmera">
          {voice.videoKind === "camera" ? <Video size={22} /> : <VideoOff size={22} />}
        </Btn>
        <Btn onClick={() => voice.setVideo(voice.videoKind === "screen" ? null : "screen")} active={voice.videoKind === "screen"} title="Compartilhar tela">
          <MonitorUp size={22} />
        </Btn>
        <ScreenQualityMenu
          quality={voice.screenQuality}
          onChange={voice.setScreenQuality}
          viewers={Math.max(0, voice.participants.length - 1)}
        />
        <Btn onClick={voice.leave} danger title="Sair da chamada">
          <PhoneOff size={22} />
        </Btn>
      </div>
    </div>
  );
}
