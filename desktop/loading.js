"use strict";
const state = new URLSearchParams(location.search).get("state") || "waking";
const $ = (id) => document.getElementById(id);

const screens = {
  waking: {
    title: "Acordando o servidor…",
    text: "O servidor gratuito hiberna quando fica sem uso. A primeira conexão pode levar cerca de um minuto.",
  },
  error: {
    title: "Não foi possível conectar",
    text: "Verifique sua internet e se o servidor está no ar. Se acabou de fazer o deploy, ele pode ainda estar iniciando.",
    retry: true,
  },
  config: {
    title: "Servidor não configurado",
    text: "Edite o arquivo config.json e troque appUrl pelo endereço do seu servidor (veja o DEPLOY.md). Depois reabra o app.",
  },
};
const s = screens[state] || screens.waking;
$("title").textContent = s.title;
$("text").textContent = s.text;
document.title = `Voidisce — ${s.title}`;
if (state !== "waking") $("spinner").hidden = true;

if (s.retry) {
  const btn = $("retry");
  btn.hidden = false;
  btn.addEventListener("click", () => window.conversaDesktop?.retry());
  btn.focus();
}

if (state === "waking") {
  const timer = $("timer");
  const start = Date.now();
  timer.hidden = false;
  const tick = () => (timer.textContent = `${Math.floor((Date.now() - start) / 1000)} s`);
  tick();
  setInterval(tick, 1000);
}
