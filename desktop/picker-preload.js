"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("picker", {
  onSources: (cb) => ipcRenderer.on("picker:sources", (_e, data) => cb(data)),
  choose: (id, audio) => ipcRenderer.send("picker:done", { id, audio }),
  cancel: () => ipcRenderer.send("picker:done", null),
});
