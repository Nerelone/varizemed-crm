export type MessageLike = {
  ts?: string | null;
  message_id?: string | null;
};

export function cmpMsg(a: MessageLike, b: MessageLike) {
  const ta = a.ts ? new Date(a.ts).getTime() : 0;
  const tb = b.ts ? new Date(b.ts).getTime() : 0;
  if (ta !== tb) return ta - tb;
  const ia = a.message_id || "";
  const ib = b.message_id || "";
  if (ia !== ib) return ia < ib ? -1 : 1;
  return 0;
}
