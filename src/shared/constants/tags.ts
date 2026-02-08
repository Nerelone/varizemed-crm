export type TagOption = {
  id: string;
  label: string;
  color: string;
  textColor?: string;
};

export const TAG_OPTIONS: TagOption[] = [
  { id: "marcacao", label: "Marcacao", color: "#22c55e", textColor: "#052e16" },
  { id: "remarcacao", label: "Remarcacao", color: "#14b8a6", textColor: "#042f2e" },
  { id: "duvida", label: "Duvida", color: "#38bdf8", textColor: "#082f49" },
  { id: "exames", label: "Exames", color: "#f59e0b", textColor: "#451a03" },
  { id: "convenio", label: "Convenio", color: "#a855f7", textColor: "#2e1065" },
  { id: "retorno", label: "Retorno", color: "#f97316", textColor: "#431407" },
  { id: "reclamacao", label: "Reclamacao", color: "#ef4444", textColor: "#450a0a" },
  { id: "urgente", label: "Urgente", color: "#ef4444", textColor: "#450a0a" }
];

export function getTagOption(id: string | null | undefined) {
  if (!id) return null;
  return TAG_OPTIONS.find((tag) => tag.id === id) || null;
}
