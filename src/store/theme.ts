import { create } from "zustand";

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "workbench.theme";

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    // Removing the attribute hands control back to the prefers-color-scheme
    // media query in tokens.css.
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

function systemIsDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

interface ThemeStore {
  choice: ThemeChoice;
  /** What is actually on screen, with "system" resolved. */
  resolved: "light" | "dark";
  set(choice: ThemeChoice): void;
  toggle(): void;
  init(): void;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  choice: "system",
  resolved: "light",

  set: (choice) => {
    localStorage.setItem(KEY, choice);
    apply(choice);
    set({
      choice,
      resolved: choice === "system" ? (systemIsDark() ? "dark" : "light") : choice,
    });
  },

  /** Cycles light → dark → light, pinning an explicit choice. */
  toggle: () => get().set(get().resolved === "dark" ? "light" : "dark"),

  init: () => {
    const stored = (localStorage.getItem(KEY) as ThemeChoice | null) ?? "system";
    apply(stored);
    set({
      choice: stored,
      resolved: stored === "system" ? (systemIsDark() ? "dark" : "light") : stored,
    });
    // Track the system while the user is on "system".
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      .addEventListener?.("change", (e) => {
        if (get().choice === "system") set({ resolved: e.matches ? "dark" : "light" });
      });
  },
}));
