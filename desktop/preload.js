"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Ponte com o app: tentar de novo, atualizar do zero (cache), estado da chamada/mute e atualização do app.
contextBridge.exposeInMainWorld("conversaDesktop", {
  isDesktop: true,
  retry: () => ipcRenderer.send("app:retry"),
  hardReload: () => ipcRenderer.send("app:hard-reload"),
  setInCall: (value) => ipcRenderer.send("app:in-call", value === true),
  // microfone: a página informa o estado; a bandeja pede para alternar
  setMuted: (value) => ipcRenderer.send("app:muted", value === true),
  onToggleMute: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("app:toggle-mute", handler);
    return () => ipcRenderer.removeListener("app:toggle-mute", handler);
  },
  // atualização do app (.exe)
  getUpdateState: () => ipcRenderer.invoke("app:update-state"),
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("app:update-state", handler);
    return () => ipcRenderer.removeListener("app:update-state", handler);
  },
  updateApp: () => ipcRenderer.send("app:update-app"),
});
