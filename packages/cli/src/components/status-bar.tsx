import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { useChatSettings } from "../providers/chat-settings";

export function StatusBar() {
  const { colors } = useTheme();
  const { mode, model } = useChatSettings();

  return (
    <box flexDirection="row" gap={1}>
      <text fg={colors.primary}>{mode === "PLAN" ? "Plan" : "Build"}</text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      <text>{model}</text>
    </box>
  );
}