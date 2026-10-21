// Atualiza o app do zero, descartando os caches.
// - No app de desktop: o processo principal limpa o cache do Chromium e recarrega
//   (e ele mesmo pede confirmação se houver chamada ativa).
// - No navegador: apaga Cache Storage e service workers e força o servidor a entregar o index.html de novo
//   (fetch com cache "reload" ignora o cache HTTP e atualiza a entrada guardada).
// inCall: no navegador, pede confirmação antes de derrubar a chamada.
export async function hardReload(inCall = false) {
  if (window.conversaDesktop?.hardReload) return window.conversaDesktop.hardReload();
  if (inCall && !window.confirm("Você está em uma chamada. A chamada cai por alguns segundos e você volta para a sala automaticamente (câmera e compartilhamento de tela precisam ser ligados de novo). Deseja continuar?")) return;
  try {
    if ("caches" in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    await fetch(location.href, { cache: "reload" });
  } catch {}
  location.reload();
}
