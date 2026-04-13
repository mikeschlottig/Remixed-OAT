import { ITheme } from "xterm";

export function syncTheme(): ITheme {
  const styles = getComputedStyle(document.body);
  
  return {
    background: styles.getPropertyValue("--background-primary").trim() || "#1e1e1e",
    foreground: styles.getPropertyValue("--text-normal").trim() || "#cccccc",
    cursor: styles.getPropertyValue("--text-accent").trim() || "#ffffff",
    selectionBackground: styles.getPropertyValue("--text-selection").trim() || "#333333",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  };
}
