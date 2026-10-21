"use strict";
const { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, ipcMain, nativeImage, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createUpdater } = require("./updater");

const DEV = process.argv.includes("--dev");
// Modo diagnóstico: imprime no terminal o que acontece ao compartilhar tela/janela (npm run debug ou CONVERSA_DEBUG=1; "--debug" é reservado pelo Node).
const DEBUG = process.argv.includes("--diag") || process.env.CONVERSA_DEBUG === "1";
const dbg = (...a) => DEBUG && console.log("[captura]", ...a);
const PLACEHOLDER = "SEU-APP";
const BG = "#282a2f";
const ICON = path.join(__dirname, "build", "icon.png");
const APP_ID = "com.conversa.desktop";

// Captura no Windows (Chromium). Há dois capturadores: a API nova (WGC) e o clássico (DXGI/GDI).
// Em alguns PCs o Windows nega a API nova ("CreateForMonitor failed ... -2147024891") e a captura
// nem inicia ("NotReadableError - Could not start video source"). Por padrão o app usa o
// capturador clássico em telas e janelas. Para ligar a API nova:
//   CONVERSA_WGC=1         telas        CONVERSA_WGC_WINDOW=1   janelas
const wgcScreen = process.env.CONVERSA_WGC === "1";
const wgcWindow = process.env.CONVERSA_WGC_WINDOW === "1";
const featureSwitch = (name, on) => ({ on: on && name, off: !on && name });
const features = [featureSwitch("AllowWgcScreenCapturer", wgcScreen), featureSwitch("AllowWgcWindowCapturer", wgcWindow)];
const enabledFeatures = features.map((f) => f.on).filter(Boolean);
const disabledFeatures = features.map((f) => f.off).filter(Boolean);
if (enabledFeatures.length) app.commandLine.appendSwitch("enable-features", enabledFeatures.join(","));
if (disabledFeatures.length) app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));
dbg("recursos ligados:", enabledFeatures.join(",") || "(nenhum)", "| desligados:", disabledFeatures.join(",") || "(nenhum)");

// Permissões que a página pode usar (só para o nosso próprio endereço).
const ALLOWED_PERMISSIONS = new Set(["media", "display-capture", "fullscreen", "clipboard-sanitized-write"]);

/* ---------- configuração ---------- */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Prioridade: variável APP_URL > %APPDATA%\Conversa\config.json > config.json do app.
// Em --dev o padrão é o Vite (http://localhost:5173).
function resolveAppUrl() {
  const bundled = readJson(path.join(__dirname, "config.json")).appUrl;
  const user = readJson(path.join(app.getPath("userData"), "config.json")).appUrl;
  const url = process.env.APP_URL || (DEV ? "http://localhost:5173" : user || bundled) || "";
  return url.trim().replace(/\/+$/, "");
}

let APP_URL = "";
let APP_ORIGIN = "";
let win = null;
let loadToken = 0; // invalida tentativas antigas quando o usuário pede "tentar de novo"

const isTrusted = (url) => {
  try {
    return !!APP_ORIGIN && new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
};

/* ---------- tela de carregamento / erro ---------- */

function showLocal(state) {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, "loading.html"), { query: { state } });
}

async function serverIsUp() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${APP_URL}/health`, { signal: ctl.signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Servidores gratuitos hibernam: tenta por até ~4 min enquanto mostra "acordando o servidor".
async function connect() {
  const token = ++loadToken;
  if (!APP_URL || APP_URL.includes(PLACEHOLDER)) return showLocal("config");
  showLocal("waking");
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await serverIsUp()) {
      if (token !== loadToken || !win || win.isDestroyed()) return;
      return void win.loadURL(APP_URL).catch(() => {}); // falhas viram did-fail-load
    }
    await new Promise((r) => setTimeout(r, 3000));
    if (token !== loadToken || !win || win.isDestroyed()) return;
  }
  showLocal("error");
}

/* ---------- atualizar do zero ---------- */

// Limpa o cache (HTTP, service workers e Cache Storage) e recarrega a página ignorando o cache.
// Não mexe em localStorage, então o nome salvo continua lá. Atalhos: F5, Ctrl+R, Ctrl+Shift+R, Ctrl+F5.
let inCall = false; // a página avisa (app:in-call) quando entra/sai de uma sala
let muted = false; // a página avisa (app:muted) quando o microfone é silenciado/reativado
let confirming = false;

// Se houver chamada ativa, pergunta antes: atualizar derruba a sala.
async function requestHardReload() {
  if (!win || win.isDestroyed() || confirming) return;
  if (inCall) {
    confirming = true;
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Atualizar", "Cancelar"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: "Atualizar",
        message: "Você está em uma chamada.",
        detail: "A chamada cai por alguns segundos e você volta para a sala automaticamente (câmera e compartilhamento de tela precisam ser ligados de novo). Deseja continuar?",
      });
      if (response !== 0) return;
    } finally {
      confirming = false;
    }
  }
  hardReload();
}

async function hardReload() {
  if (!win || win.isDestroyed()) return;
  inCall = false;
  muted = false;
  refreshTray();
  const ses = win.webContents.session;
  try {
    await ses.clearCache();
    await ses.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
  } catch (err) {
    console.error("[atualizar] falha ao limpar o cache:", err);
  }
  if (!win || win.isDestroyed()) return;
  // Se está na tela local (carregando/erro), recomeça a conexão; senão recarrega a página atual.
  if (win.webContents.getURL().startsWith("file://")) return connect();
  win.webContents.reloadIgnoringCache();
}

/* ---------- seletor de tela ---------- */

let pickerOpen = false;

// Lista telas e janelas; se a captura de telas falhar, ainda oferece as janelas.
async function listSources() {
  const base = { thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true };
  try {
    return await desktopCapturer.getSources({ ...base, types: ["screen", "window"] });
  } catch (err) {
    console.error("[captura] falha ao listar telas e janelas:", err);
  }
  try {
    return await desktopCapturer.getSources({ ...base, types: ["window"] });
  } catch (err) {
    console.error("[captura] falha ao listar janelas:", err);
    return [];
  }
}

async function pickSource(parent, request) {
  if (pickerOpen) return null;
  pickerOpen = true;
  try {
    const sources = await listSources();
    if (!sources.length) {
      dialog.showErrorBox("Compartilhar tela", "Não foi possível listar telas ou janelas para compartilhar.");
      return null;
    }

    const picker = new BrowserWindow({
      parent,
      modal: true,
      width: 760,
      height: 560,
      minWidth: 560,
      minHeight: 420,
      show: false,
      title: "Compartilhar tela",
      backgroundColor: BG,
      autoHideMenuBar: true,
      icon: ICON,
      webPreferences: {
        preload: path.join(__dirname, "picker-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    picker.removeMenu();
    picker.loadFile(path.join(__dirname, "picker.html"));

    return await new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        ipcMain.removeListener("picker:done", onDone);
        resolve(value);
        if (!picker.isDestroyed()) picker.close();
      };
      const onDone = (event, result) => {
        if (event.sender !== picker.webContents) return;
        const source = sources.find((s) => s.id === result?.id);
        finish(source ? { source, audio: !!result.audio } : null);
      };
      ipcMain.on("picker:done", onDone);
      picker.on("closed", () => finish(null));
      picker.webContents.once("did-finish-load", () => {
        picker.webContents.send("picker:sources", {
          audioRequested: !!request.audioRequested,
          sources: sources.map((s) => ({
            id: s.id,
            name: s.name,
            isScreen: s.id.startsWith("screen:"),
            thumb: s.thumbnail.toDataURL(),
            icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
          })),
        });
        picker.show();
      });
    });
  } finally {
    pickerOpen = false;
  }
}

function setupSession() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isTrusted(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && isTrusted(origin));

  // getDisplayMedia(): abre o nosso seletor e devolve a fonte escolhida.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    dbg("pedido da página: vídeo =", request.videoRequested, "| áudio =", request.audioRequested, "| origem =", request.securityOrigin);
    if (!isTrusted(request.securityOrigin) || !win || win.isDestroyed()) {
      dbg("pedido negado: origem não confiável");
      return callback({});
    }
    try {
      const picked = await pickSource(win, request);
      if (!picked) {
        dbg("seleção cancelada ou vazia");
        return callback({});
      }
      const streams = { video: picked.source };
      // Windows: "loopback" captura o som do sistema (todos os apps).
      if (picked.audio && request.audioRequested) streams.audio = "loopback";
      dbg("fonte escolhida:", picked.source.id, "|", picked.source.name, "| áudio do sistema =", !!streams.audio);
      callback(streams);
    } catch (err) {
      console.error("[captura] erro no handler:", err);
      callback({});
    }
  });
}

/* ---------- atualização do app ---------- */

// Quem confere/baixa/instala é o updater.js; aqui ficam os diálogos e a integração com a bandeja e a página.
const updater = createUpdater({
  getBaseUrl: () => APP_URL,
  onChange: (state) => {
    refreshTray();
    if (win && !win.isDestroyed()) win.webContents.send("app:update-state", state);
  },
});

let updating = false;
let notifiedVersion = null;

// "autoUpdate": true em config.json (ou em %APPDATA%\Conversa\config.json) instala sozinho, sem perguntar,
// quando não há chamada ativa. Padrão: semiautomático (avisa e pergunta).
const autoUpdateEnabled = () => {
  const user = readJson(path.join(app.getPath("userData"), "config.json")).autoUpdate;
  return (user ?? readJson(path.join(__dirname, "config.json")).autoUpdate) === true;
};

// Diálogo que não depende da janela estar visível (ela pode estar escondida na bandeja).
function box(options) {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// auto: true = fluxo sem perguntas (só chamado quando autoUpdate está ligado e não há chamada).
async function updateApp({ auto = false } = {}) {
  if (updating) return;
  updating = true;
  try {
    const before = updater.snapshot();
    if (!before.supported) {
      if (!auto) {
        await box({
          type: "info",
          title: "Atualizar app",
          message: "A atualização do app não está disponível aqui.",
          detail: "Ela funciona no instalador e no executável portátil (não no modo de desenvolvimento).",
        });
      }
      return;
    }

    const result = await updater.check();
    if (result.status === "error") {
      if (!auto) {
        await box({ type: "warning", title: "Atualizar app", message: "Não foi possível verificar atualizações.", detail: String(result.error) });
      }
      return;
    }
    if (result.status !== "available") {
      if (!auto) {
        await box({ type: "info", title: "Atualizar app", message: "Você já está na versão mais recente.", detail: `Versão ${before.current}.` });
      }
      return;
    }

    const { info } = result;
    if (!auto) {
      const notes = info.notes ? `\n\n${info.notes}` : "";
      const warn = inCall ? "\n\nVocê está em uma chamada: ela será encerrada quando o app reiniciar." : "";
      const { response } = await box({
        type: "question",
        buttons: ["Atualizar agora", "Depois"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Atualizar app",
        message: `Nova versão ${info.version} disponível (você está na ${before.current}).`,
        detail: `O app baixa a atualização, fecha e abre de novo sozinho; a versão antiga é substituída.${warn}${notes}`,
      });
      if (response !== 0) return;
    }

    let file;
    try {
      file = await updater.download(info);
    } catch (err) {
      if (!auto) await box({ type: "error", title: "Atualizar app", message: "Falha ao baixar a atualização.", detail: String(err.message ?? err) });
      return;
    }
    if (auto && inCall) return; // uma chamada começou durante o download: tenta de novo mais tarde

    try {
      await updater.apply(file);
    } catch (err) {
      await box({ type: "error", title: "Atualizar app", message: "Não foi possível iniciar a atualização.", detail: String(err.message ?? err) });
      return;
    }
    quitApp();
  } finally {
    updating = false;
  }
}

// Confere em segundo plano: ao abrir (depois de 20 s) e a cada 30 min.
function startUpdateChecks() {
  const run = async () => {
    if (updating || updater.snapshot().downloading) return;
    const result = await updater.check();
    if (result.status !== "available") return;
    if (autoUpdateEnabled() && !inCall) return void updateApp({ auto: true });
    if (notifiedVersion === result.info.version) return;
    notifiedVersion = result.info.version;
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "Nova versão do Voidisce",
        body: `A versão ${result.info.version} está disponível. Clique para atualizar.`,
        icon: ICON,
      });
      n.on("click", () => updateApp());
      n.show();
    }
  };
  setTimeout(run, 20_000);
  setInterval(run, 30 * 60_000).unref?.();
}

/* ---------- bandeja do sistema ---------- */

// Minimizar ou fechar a janela só a esconde: o app (e a chamada) continuam rodando e o ícone fica
// ao lado do relógio. Menu da bandeja: abrir, silenciar o microfone, atualizar o app e sair.
let tray = null;
let trayImages = null;
let isQuitting = false;

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    connect();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function toggleMuteFromTray() {
  if (inCall && win && !win.isDestroyed()) win.webContents.send("app:toggle-mute");
}

// Reconstrói menu, ícone (com selo vermelho se mutado), dica e o selo na barra de tarefas.
function refreshTray() {
  const u = updater.snapshot();
  if (win && !win.isDestroyed()) {
    win.setProgressBar(u.downloading && u.progress > 0 ? u.progress : -1);
    if (process.platform === "win32" && trayImages) {
      win.setOverlayIcon(muted ? trayImages.badge : null, muted ? "Microfone silenciado" : "");
    }
  }
  if (!tray || tray.isDestroyed() || !trayImages) return;

  const updateLabel = u.downloading
    ? `Baixando atualização… ${Math.round(u.progress * 100)}%`
    : u.available
      ? `Atualizar app (versão ${u.available} disponível)`
      : "Atualizar app";

  tray.setImage(muted ? trayImages.muted : trayImages.normal);
  tray.setToolTip(
    u.downloading
      ? `Voidisce — baixando atualização ${Math.round(u.progress * 100)}%`
      : muted
        ? "Voidisce — microfone silenciado"
        : inCall
          ? "Voidisce — em chamada"
          : "Voidisce"
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Conversa", click: showWindow },
      { label: muted ? "Ativar microfone" : "Silenciar microfone", enabled: inCall, click: toggleMuteFromTray },
      { type: "separator" },
      { label: updateLabel, enabled: !u.downloading && !updating, click: () => updateApp() },
      { label: `Versão ${u.current}`, enabled: false },
      { type: "separator" },
      { label: "Sair", click: quitApp },
    ])
  );
}

function createTray() {
  const img = (name) => nativeImage.createFromPath(path.join(__dirname, "build", name)); // carrega também os @2x, @3x…
  trayImages = { normal: img("tray.png"), muted: img("tray-muted.png"), badge: img("mute-badge.png") };
  if (trayImages.normal.isEmpty()) trayImages.normal = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  if (trayImages.muted.isEmpty()) trayImages.muted = trayImages.normal;
  tray = new Tray(trayImages.normal);
  tray.on("click", showWindow);
  refreshTray();
}

/* ---------- janela ---------- */

// Injetado só no modo debug: registra o resultado de getDisplayMedia e quando a faixa de vídeo termina.
const DEBUG_SCRIPT = `(() => {
  if (window.__conversaDbg) return;
  window.__conversaDbg = true;
  const md = navigator.mediaDevices;
  const orig = md.getDisplayMedia.bind(md);
  md.getDisplayMedia = async (constraints) => {
    const t0 = performance.now();
    console.log("[getDisplayMedia] pedido", JSON.stringify(constraints));
    try {
      const stream = await orig(constraints);
      for (const t of stream.getTracks()) {
        console.log("[getDisplayMedia] faixa", t.kind, "|", t.label, "|", t.readyState, "|", JSON.stringify(t.getSettings()));
        t.addEventListener("ended", () => console.log("[getDisplayMedia] faixa TERMINOU após", Math.round(performance.now() - t0), "ms:", t.kind));
        t.addEventListener("mute", () => console.log("[getDisplayMedia] faixa sem frames (mute):", t.kind));
        t.addEventListener("unmute", () => console.log("[getDisplayMedia] faixa com frames (unmute):", t.kind));
      }
      return stream;
    } catch (e) {
      console.log("[getDisplayMedia] ERRO", e.name, "-", e.message);
      throw e;
    }
  };
})();`;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: "Voidisce",
    backgroundColor: BG,
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // não "dorme" o áudio quando a janela fica minimizada/atrás
    },
  });

  // Links externos abrem no navegador padrão; a janela nunca sai do nosso endereço.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://") || isTrusted(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */ || url.startsWith("file://")) return;
    showLocal("error");
  });

  if (DEBUG) {
    // Mostra no terminal os logs da página (console.log/erro). A assinatura do evento mudou entre versões do Electron.
    win.webContents.on("console-message", (...args) => {
      const e = args[0];
      console.log("[página]", e && typeof e === "object" && "message" in e ? e.message : args[2]);
    });
    win.webContents.on("did-finish-load", () => {
      if (isTrusted(win.webContents.getURL())) win.webContents.executeJavaScript(DEBUG_SCRIPT).catch(() => {});
    });
  }

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (key === "f5" || ((input.control || input.meta) && key === "r")) {
      event.preventDefault();
      if (!input.isAutoRepeat) requestHardReload();
    } else if (DEV && key === "f12") {
      win.webContents.toggleDevTools();
    }
  });

  win.webContents.on("did-start-loading", () => {
    // página nova = sem chamada e microfone no padrão
    inCall = false;
    muted = false;
    refreshTray();
  });

  // Fechar (X) e minimizar mandam para a bandeja em vez de encerrar.
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("minimize", (event) => {
    event.preventDefault();
    win.hide();
  });

  win.on("closed", () => (win = null));
}

/* ---------- ciclo de vida ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    isQuitting = true;
    tray?.destroy();
  });
  app.on("session-end", () => (isQuitting = true)); // desligar/reiniciar o Windows não pode ser bloqueado

  ipcMain.on("app:retry", (event) => {
    if (win && event.sender === win.webContents) connect();
  });

  ipcMain.on("app:hard-reload", (event) => {
    if (win && event.sender === win.webContents) requestHardReload();
  });

  ipcMain.on("app:in-call", (event, value) => {
    if (!win || event.sender !== win.webContents) return;
    inCall = value === true;
    if (!inCall) muted = false;
    refreshTray();
  });

  ipcMain.on("app:muted", (event, value) => {
    if (!win || event.sender !== win.webContents) return;
    muted = value === true;
    refreshTray();
  });

  ipcMain.handle("app:update-state", (event) => (win && event.sender === win.webContents ? updater.snapshot() : null));

  ipcMain.on("app:update-app", (event) => {
    if (win && event.sender === win.webContents) updateApp();
  });

  app.whenReady().then(() => {
    if (!DEV) Menu.setApplicationMenu(null);
    if (process.platform === "win32") app.setAppUserModelId(APP_ID); // necessário para as notificações do Windows
    updater.cleanup();
    APP_URL = resolveAppUrl();
    try {
      APP_ORIGIN = APP_URL ? new URL(APP_URL).origin : "";
    } catch {
      APP_URL = "";
    }
    setupSession();
    createWindow();
    createTray();
    connect();
    startUpdateChecks();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) {
        createWindow();
        connect();
      }
    });
  });

  app.on("window-all-closed", () => app.quit());
}
