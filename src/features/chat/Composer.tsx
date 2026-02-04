export function Composer({
  value,
  onChange,
  onSend,
  onReopen,
  showReopen,
  disabled
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onReopen: () => void;
  showReopen: boolean;
  disabled: boolean;
}) {
  return (
    <div className="chat-input">
      {showReopen ? (
        <button className="btn btn-warn" onClick={onReopen} disabled={disabled}>
          🔓 Reabrir Conversa
        </button>
      ) : (
        <>
          <input
            placeholder="Escreva uma mensagem..."
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            disabled={disabled}
          />
          <button className="btn btn-acc" onClick={onSend} disabled={disabled}>
            Enviar
          </button>
        </>
      )}
    </div>
  );
}
