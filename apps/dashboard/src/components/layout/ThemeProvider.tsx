import { createContext, useContext, useLayoutEffect, useState, useCallback, type ReactNode } from "react";

type Theme = "light" | "dark";

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
} | null>(null);

const STORAGE = "sohwe-theme";

function readStored(): Theme {
  if (typeof window === "undefined") return "dark";
  const v = localStorage.getItem(STORAGE);
  return v === "light" || v === "dark" ? v : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
    localStorage.setItem(STORAGE, theme);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used under ThemeProvider");
  return ctx;
}
