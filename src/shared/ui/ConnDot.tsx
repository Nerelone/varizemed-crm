export function ConnDot({ connected }: { connected: boolean }) {
  return (
    <div
      id="connDot"
      title={connected ? "Polling ativo" : "Desconectado"}
      style={{ color: connected ? "#22c55e" : "#9ca3af" }}
    >
      ●
    </div>
  );
}
