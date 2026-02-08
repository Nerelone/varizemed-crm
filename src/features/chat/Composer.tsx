export function Composer({
  value,
  onChange,
  onSend,
  onReopen,
  onOpenQuickReplies,
  showReopen,
  disabled,
  inputDisabled
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onReopen: () => void;
  onOpenQuickReplies?: () => void;
  showReopen: boolean;
  disabled: boolean;
  inputDisabled?: boolean;
}) {
  const isInputDisabled = inputDisabled ?? disabled;
  return (
    <div className="chat-input">
      {showReopen ? (
        <button className="btn btn-warn" onClick={onReopen} disabled={disabled}>
          Reabrir Conversa
        </button>
      ) : (
        <>
          {onOpenQuickReplies ? (
            <button className="btn btn-ghost" onClick={onOpenQuickReplies} disabled={isInputDisabled}>
              Respostas
            </button>
          ) : null}
          <textarea
            placeholder="Escreva uma mensagem..."
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            spellCheck={true}
            autoCorrect="on"
            autoCapitalize="sentences"
            lang="pt-BR"
            rows={2}
            disabled={isInputDisabled}
          />
          <button className="btn btn-acc" onClick={onSend} disabled={isInputDisabled}>
            Enviar
          </button>
        </>
      )}
    </div>
  );
}
