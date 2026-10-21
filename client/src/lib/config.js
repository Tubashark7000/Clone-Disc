// Endereço do servidor de sinalização.
// - Dev (vite): http://localhost:3001
// - Produção: o servidor também entrega o cliente, então é a mesma origem.
// - VITE_SERVER_URL sobrescreve nos dois casos.
export const SERVER =
  import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);
