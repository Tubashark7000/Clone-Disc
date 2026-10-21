import { useState } from "react";
import { Download, LogIn, Plus, RefreshCw } from "lucide-react";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { hardReload } from "../lib/refresh";

// Aceita o código puro ou o link da sala (com ?sala=CÓDIGO) colado no campo.
function extractCode(text) {
  const t = String(text ?? "").trim();
  try {
    const c = new URL(t).searchParams.get("sala");
    if (c) return c.toUpperCase().replace(/[^A-Z0-9]/g, "");
  } catch {}
  return t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export default function Home({ name, ready, error, onCreate, onJoin, onRename }) {
  const [code, setCode] = useState(() => extractCode(new URLSearchParams(location.search).get("sala")));
  const [busy, setBusy] = useState(false);
  const update = useAppUpdate(); // só existe no app de desktop
  const run = async (fn) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <main className="relative grid min-h-dvh place-items-center bg-main p-6">
      <div className="absolute right-4 top-4 flex items-center gap-3 text-sm text-muted">
        <button
          onClick={() => hardReload()}
          title="Atualizar do zero (limpa o cache e recarrega)"
          className="flex items-center gap-1 hover:text-ink"
        >
          <RefreshCw size={14} /> atualizar
        </button>
        {update?.supported && (
          <button
            onClick={update.run}
            disabled={update.downloading}
            title={`Versão instalada: ${update.current}. Procura uma versão nova do app e atualiza.`}
            className={`flex items-center gap-1 hover:text-ink disabled:opacity-60 ${update.available ? "font-medium text-live" : ""}`}
          >
            <Download size={14} />
            {update.downloading
              ? `baixando ${Math.round(update.progress * 100)}%`
              : update.available
                ? `atualizar app (v${update.available})`
                : "atualizar app"}
          </button>
        )}
        <span>{name}</span>
        <button onClick={onRename} className="underline hover:text-ink">trocar nome</button>
      </div>

      <div className="flex w-full max-w-xs flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold">Olá, {name}</h1>

        <button
          disabled={!ready || busy}
          onClick={() => run(onCreate)}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-3 font-medium hover:brightness-110 disabled:opacity-50"
        >
          <Plus size={20} /> Criar sala
        </button>

        <p className="text-sm text-muted">ou entre com o código de uma sala</p>

        <form
          onSubmit={(e) => (e.preventDefault(), code.trim() && run(() => onJoin(code.trim())))}
          className="flex w-full gap-2"
        >
          <input
            value={code}
            onChange={(e) => setCode(extractCode(e.target.value))}
            placeholder="CÓDIGO"
            className="min-w-0 flex-1 rounded-lg bg-field px-3 py-3 text-center tracking-widest outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            disabled={!ready || busy || !code.trim()}
            className="flex items-center gap-2 rounded-lg bg-field px-4 py-3 font-medium hover:bg-field/70 disabled:opacity-50"
          >
            <LogIn size={18} /> Entrar
          </button>
        </form>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </main>
  );
}
