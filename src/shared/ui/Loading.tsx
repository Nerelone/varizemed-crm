export function Loading({ label }: { label: string }) {
  return (
    <div style={{ textAlign: "center", padding: "10px", color: "var(--muted)", fontSize: 12 }}>
      {label}
    </div>
  );
}
