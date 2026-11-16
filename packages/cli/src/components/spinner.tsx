import { useEffect, useState } from "react";
import { useTheme } from "../providers/theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const { colors } = useTheme();
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);

  return <text fg={colors.primary}>{FRAMES[i]}</text>;
}