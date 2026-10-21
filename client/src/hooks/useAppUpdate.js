import { useEffect, useState } from "react";

// Estado da atualização do app de desktop (.exe). No navegador retorna null (não há o que atualizar).
// { supported, current, available (versão nova ou null), checking, downloading, progress (0–1) }
export function useAppUpdate() {
  const desktop = window.conversaDesktop;
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!desktop?.getUpdateState) return;
    let alive = true;
    desktop
      .getUpdateState()
      .then((s) => alive && s && setState(s))
      .catch(() => {});
    const off = desktop.onUpdateState?.((s) => setState(s));
    return () => {
      alive = false;
      off?.();
    };
  }, [desktop]);

  if (!desktop?.updateApp || !state) return null;
  return { ...state, run: () => desktop.updateApp() };
}
