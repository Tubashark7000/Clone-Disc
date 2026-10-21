"use strict";
// Atualização do app de desktop, sem dependências extras. Funciona nos dois formatos:
//  - instalador (NSIS): baixa o novo Setup e roda em modo silencioso; ele desinstala a versão antiga,
//    instala a nova e reabre o app;
//  - portátil: baixa o novo .exe ao lado do atual e, depois que o app fecha, um script do PowerShell
//    troca o arquivo (a versão antiga deixa de existir) e abre o novo.
// O servidor publica {appUrl}/updates/latest.json (gerado por `npm run release`) e os .exe.
const { app, net } = require("electron");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const isPortable = () => process.platform === "win32" && !!process.env.PORTABLE_EXECUTABLE_FILE;
const isSupported = () => process.platform === "win32" && app.isPackaged;
const workDir = () => path.join(os.tmpdir(), "voidisce-update");

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  return m ? m.slice(1).map(Number) : null;
}

// a > b ?
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Aceita caminho relativo (arquivo no próprio servidor) ou URL absoluta (ex.: GitHub Releases).
// Só https; http apenas para localhost (desenvolvimento).
function resolveUrl(file, base) {
  const u = new URL(file, base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error("o endereço da atualização precisa ser https");
  }
  return u.toString();
}

// Troca o arquivo portátil: tenta mover o novo por cima do antigo até o antigo ser liberado (o app fechar).
const REPLACE_PS1 = `param([string]$Source, [string]$Target)
$ok = $false
for ($i = 0; $i -lt 120 -and -not $ok; $i++) {
  try { Move-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop; $ok = $true }
  catch { Start-Sleep -Milliseconds 500 }
}
if ($ok) { Start-Process -FilePath $Target }
`;

function launch(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", ...opts });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function createUpdater({ getBaseUrl, onChange }) {
  const state = {
    supported: isSupported(),
    current: app.getVersion(),
    info: null, // dados da versão nova (ou null)
    checking: false,
    downloading: false,
    progress: 0,
  };
  let checkPromise = null;

  const snapshot = () => ({
    supported: state.supported,
    portable: isPortable(),
    current: state.current,
    available: state.info?.version ?? null,
    checking: state.checking,
    downloading: state.downloading,
    progress: state.progress,
  });
  const emit = () => onChange?.(snapshot());

  async function fetchTimeout(url, ms, init = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await net.fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // -> { status: "available", info } | { status: "current", version } | { status: "unsupported" } | { status: "error", error }
  function check() {
    if (!state.supported) return Promise.resolve({ status: "unsupported" });
    if (checkPromise) return checkPromise;
    checkPromise = (async () => {
      state.checking = true;
      emit();
      try {
        const base = getBaseUrl();
        if (!base) throw new Error("o endereço do servidor não está configurado");
        const dir = `${base}/updates/`;
        const res = await fetchTimeout(`${dir}latest.json?t=${Date.now()}`, 15_000, { cache: "no-store" });
        if (!res.ok) throw new Error(`o servidor respondeu ${res.status} ao buscar latest.json`);
        const manifest = await res.json().catch(() => {
          throw new Error("latest.json inválido");
        });
        if (!parseVersion(manifest?.version)) throw new Error("latest.json sem uma versão válida");
        if (!isNewer(manifest.version, state.current)) {
          state.info = null;
          return { status: "current", version: state.current };
        }
        const entry = isPortable() ? manifest.portable : manifest.setup;
        if (!entry?.url) {
          throw new Error(`a versão ${manifest.version} não tem o arquivo ${isPortable() ? "portátil" : "do instalador"}`);
        }
        state.info = {
          version: String(manifest.version).replace(/^v/, ""),
          notes: typeof manifest.notes === "string" ? manifest.notes : "",
          url: resolveUrl(entry.url, dir),
          sha512: typeof entry.sha512 === "string" ? entry.sha512 : "",
          size: Number(entry.size) || 0,
        };
        return { status: "available", info: state.info };
      } catch (err) {
        return { status: "error", error: err?.name === "AbortError" ? "tempo esgotado" : err?.message ?? String(err) };
      } finally {
        state.checking = false;
        checkPromise = null;
        emit();
      }
    })();
    return checkPromise;
  }

  // Baixa e confere (tamanho e SHA-512). Retorna o caminho do arquivo baixado.
  async function download(info) {
    const dest = isPortable()
      ? `${process.env.PORTABLE_EXECUTABLE_FILE}.update`
      : path.join(workDir(), `Voidisce-Setup-${info.version}.exe`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    state.downloading = true;
    state.progress = 0;
    emit();

    const ctl = new AbortController();
    let stall;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctl.abort(), 60_000); // 60 s sem receber nada = falha
    };
    let out;
    try {
      arm();
      const res = await net.fetch(info.url, { signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`o servidor respondeu ${res.status} ao baixar o arquivo`);
      const total = Number(res.headers.get("content-length")) || info.size || 0;
      const hash = crypto.createHash("sha512");
      out = fs.createWriteStream(dest);
      const reader = res.body.getReader();
      let got = 0;
      let lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await once(out, "drain");
        if (total) {
          state.progress = Math.min(1, got / total);
          const pct = Math.floor(state.progress * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            emit();
          }
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (info.size && got !== info.size) throw new Error("o arquivo baixado está incompleto");
      if (info.sha512 && hash.digest("base64") !== info.sha512) {
        throw new Error("a verificação de integridade (SHA-512) falhou");
      }
      return dest;
    } catch (err) {
      out?.destroy();
      fs.rmSync(dest, { force: true });
      throw new Error(err?.name === "AbortError" ? "a conexão ficou parada por 60 s" : err?.message ?? String(err));
    } finally {
      clearTimeout(stall);
      state.downloading = false;
      emit();
    }
  }

  // Dispara a troca. Depois que isto retornar, quem chamou deve encerrar o app.
  async function apply(file) {
    if (isPortable()) {
      const script = path.join(workDir(), "replace.ps1");
      fs.mkdirSync(workDir(), { recursive: true });
      fs.writeFileSync(script, REPLACE_PS1, "utf8");
      await launch(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Source", file, "-Target", process.env.PORTABLE_EXECUTABLE_FILE],
        { windowsHide: true }
      );
      return;
    }
    const args = ["/S", "--updated", "--force-run"];
    try {
      await launch(file, args);
    } catch (err) {
      // Instalação "para todos os usuários" pede permissão de administrador: usa o elevate.exe que acompanha o app.
      const elevate = path.join(process.resourcesPath, "elevate.exe");
      if ((err.code === "UNKNOWN" || err.code === "EACCES") && fs.existsSync(elevate)) await launch(elevate, [file, ...args]);
      else throw err;
    }
  }

  // Apaga restos de atualizações anteriores (instalador baixado, script, .update do portátil).
  function cleanup() {
    try {
      fs.rmSync(workDir(), { recursive: true, force: true });
    } catch {}
    if (isPortable()) {
      try {
        fs.rmSync(`${process.env.PORTABLE_EXECUTABLE_FILE}.update`, { force: true });
      } catch {}
    }
  }

  return { snapshot, check, download, apply, cleanup };
}

module.exports = { createUpdater, isNewer };
