import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_CHAT_MODEL_ID, type SupportedChatModelId } from "@CodeLeeD/shared";
import { Mode } from "@CodeLeeD/database/enums";

type ChatSettings = {
  mode: Mode;
  model: SupportedChatModelId;
  setMode: (mode: Mode) => void;
  setModel: (model: SupportedChatModelId) => void;
  toggleMode: () => void;
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
  const [mode, setMode] = useState<Mode>(Mode.BUILD);
  const [model, setModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === Mode.BUILD ? Mode.PLAN : Mode.BUILD));
  }, []);

  const value = useMemo(
    () => ({ mode, model, setMode, setModel, toggleMode }),
    [mode, model, toggleMode],
  );

  return (
    <ChatSettingsContext.Provider value={value}>
      {children}
    </ChatSettingsContext.Provider>
  );
}