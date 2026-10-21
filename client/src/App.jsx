import { useEffect, useRef, useState } from "react";
import { useSocket } from "./hooks/useSocket";
import { useVoice } from "./hooks/useVoice";
import Home from "./components/Home";
import VoiceStage from "./components/VoiceStage";

// Ao recarregar durante uma chamada, a página guarda o código da sala (pagehide) e, ao abrir de novo,
// volta sozinha para ela. Só vale por 30 s e é lido uma única vez.
const REJOIN = (() => {
  try {
    const r = JSON.parse(sessionStorage.getItem("rejoin"));
    sessionStorage.removeItem("rejoin");
    return r && typeof r.code === "string" && Date.now() - r.t < 30_000 ? r.code : null;
  } catch {
    return null;
  }
})();

function Login({ onSubmit }) {
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(e) => (e.preventDefault(), name.trim() && onSubmit(name.trim()))}
      className="grid h-full place-items-center bg-rail"
    >
      <div className="w-80 space-y-4 rounded-xl bg-side p-6">
        <h1 className="text-xl font-semibold">Qual é o seu nome?</h1>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Seu nome"
          maxLength={32}
          className="w-full rounded bg-field px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button className="w-full rounded bg-accent py-2 font-medium hover:brightness-110">Continuar</button>
      </div>
    </form>
  );
}

function Session({ name, onRename }) {
  const { socket, me } = useSocket(name);
  const voice = useVoice(socket);

  const rejoined = useRef(false);
  useEffect(() => {
    if (!REJOIN || rejoined.current || !socket || !me) return;
    rejoined.current = true;
    voice.join({ code: REJOIN });
  }, [socket, me]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!voice.roomCode) return;
    const save = () => {
      try {
        sessionStorage.setItem("rejoin", JSON.stringify({ code: voice.roomCode, t: Date.now() }));
      } catch {}
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [voice.roomCode]);

  // Avisa o app de desktop se há chamada ativa (ele pede confirmação antes de atualizar).
  const inCall = !!voice.roomCode;
  useEffect(() => {
    window.conversaDesktop?.setInCall?.(inCall);
    return () => window.conversaDesktop?.setInCall?.(false);
  }, [inCall]);

  // Bandeja do Windows: informa se o microfone está silenciado e recebe o pedido de silenciar/ativar.
  useEffect(() => {
    window.conversaDesktop?.setMuted?.(inCall && voice.muted);
  }, [inCall, voice.muted]);
  useEffect(() => window.conversaDesktop?.onToggleMute?.(voice.toggleMute), [voice.toggleMute]);

  if (voice.roomCode) return <VoiceStage voice={voice} me={me} />;
  return (
    <Home
      name={name}
      ready={!!socket && !!me}
      error={voice.error}
      onRename={onRename}
      onCreate={() => voice.join({ create: true })}
      onJoin={(code) => voice.join({ code })}
    />
  );
}

export default function App() {
  const [name, setName] = useState(() => localStorage.getItem("name") ?? "");
  if (!name) return <Login onSubmit={(n) => (localStorage.setItem("name", n), setName(n))} />;
  return <Session key={name} name={name} onRename={() => (localStorage.removeItem("name"), setName(""))} />;
}
