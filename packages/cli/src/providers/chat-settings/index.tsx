import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_CHAT_MODEL_ID, type SupportedChatModelId } from "@CodeLeeD/shared";
import type { Mode } from "@CodeLeeD/database/enums";

type ChatSettings = {
  mode: Mode;
  model: SupportedChatModelId;
  setMode: (mode: Mode) => void;
  setModel: (model: SupportedChatModelId) => void;
};

const ChatSettingsContext = createContext<ChatSettings | null>(null);

export function useChatSettings(): ChatSettings {
  const value = useContext(ChatSettingsContext);
  if (!value) {
    throw new Error("useChatSettings must be used within a ChatSettingsProvider");
  }
  return value;
}

export function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("BUILD");
  const [model, setModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID);

  const value = useMemo(
    () => ({ mode, model, setMode, setModel }),
    [mode, model],
  );

  return (
    <ChatSettingsContext.Provider value={value}>
      {children}
    </ChatSettingsContext.Provider>
  );
}