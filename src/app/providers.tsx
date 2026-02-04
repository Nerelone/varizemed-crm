import type { ReactNode } from "react";
import { ToastProvider } from "../shared/ui/Toast";
import { AuthProvider } from "../features/auth/authStore";
import { ConversationsProvider } from "../features/conversations/conversationsStore";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>
        <ConversationsProvider>{children}</ConversationsProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
