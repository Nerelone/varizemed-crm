import { useEffect, useState } from "react";
import { useAuth } from "./authStore";

export function AuthPage({ open, canClose, onClose }: { open: boolean; canClose: boolean; onClose: () => void }) {
  const { username, displayName, usePrefix, saveProfile } = useAuth();
  const [localName, setLocalName] = useState(displayName);
  const [localUsePrefix, setLocalUsePrefix] = useState(usePrefix);

  useEffect(() => {
    if (!open) return;
    setLocalName(displayName);
    setLocalUsePrefix(usePrefix);
  }, [open, displayName, usePrefix]);

  const handleSave = async () => {
    await saveProfile(localName, localUsePrefix);
    if (canClose) onClose();
  };

  return (
    <div className={`overlay ${open ? "show" : ""}`}>
      <div className="modal">
        <h3 style={{ margin: "0 0 12px 0" }}>Configurar perfil</h3>

        <div className="grid">
          <label>Usuário conectado</label>
          <div className="user-info">
            <span className="badge">Logado</span>
            <span className="username">{username || "-"}</span>
          </div>

          <div className="toggle-container">
            <label className="toggle-label">Usar nome de exibição</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={localUsePrefix}
                onChange={(event) => setLocalUsePrefix(event.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
          <small style={{ color: "var(--muted)", fontSize: 11, marginTop: -8 }}>
            Quando ativado, suas mensagens incluirão seu nome de exibição como prefixo
          </small>

          <div style={{ display: localUsePrefix ? "grid" : "none" }}>
            <label>Nome de Exibição</label>
            <input
              type="text"
              value={localName}
              onChange={(event) => setLocalName(event.target.value)}
              placeholder="Ex: Rafael, Dr. Silva, Atendente"
              maxLength={50}
            />
            <small style={{ color: "var(--muted)", fontSize: 11, marginTop: -8 }}>
              Este nome aparecerá como prefixo nas suas mensagens
            </small>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {canClose ? (
              <button className="btn" onClick={onClose} style={{ flex: 1 }}>
                Fechar
              </button>
            ) : null}
            <button className="btn btn-acc" onClick={handleSave} style={{ flex: 1 }}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
