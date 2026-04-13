import { ItemView, WorkspaceLeaf, Menu } from "obsidian";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import { Unicode11Addon } from "xterm-addon-unicode11";
import { SidecarBridge } from "./SidecarBridge";
import { syncTheme } from "./ThemeSync";

export const VIEW_TYPE_TERMINAL = "agentic-terminal-view";

export class TerminalView extends ItemView {
  terminal: Terminal | null = null;
  fitAddon: FitAddon | null = null;
  bridge: SidecarBridge | null = null;
  container: HTMLElement;
  themeInterval: number | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_TERMINAL;
  }

  getDisplayText() {
    return "Agentic Terminal";
  }

  async onOpen() {
    try {
      this.container = this.contentEl.createDiv({ cls: "oat-terminal-container" });
      this.container.style.width = "100%";
      this.container.style.height = "100%";
      this.container.style.backgroundColor = "var(--background-primary)";

      this.terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--font-monospace)",
        fontSize: 14,
        theme: syncTheme(),
      });

      this.fitAddon = new FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.loadAddon(new Unicode11Addon());
      this.terminal.unicode.activeVersion = "11";

      this.terminal.open(this.container);
      
      try {
        this.terminal.loadAddon(new WebglAddon());
      } catch (e) {
        console.warn("WebGL addon failed to load, falling back to canvas", e);
      }

      // Defer fitting to ensure DOM has painted and dimensions are available
      requestAnimationFrame(() => {
        try {
          this.fitAddon?.fit();
        } catch (e) {
          console.warn("Failed to fit terminal on mount", e);
        }
      });

      // Initialize Bridge
      this.bridge = new SidecarBridge(this.app, this.terminal);
      this.bridge.connect();

      this.terminal.onData((data) => {
        this.bridge?.sendStdin(data);
      });

      this.registerEvent(
        this.app.workspace.on("resize", () => {
          try {
            this.fitAddon?.fit();
          } catch (e) {
            console.error("Failed to fit terminal on resize", e);
          }
        })
      );

      this.themeInterval = window.setInterval(() => {
        if (this.terminal) {
          try {
            const theme = syncTheme();
            this.terminal.options.theme = theme;
          } catch (e) {
            console.error("Failed to sync theme", e);
          }
        }
      }, 5000);
      
      this.registerInterval(this.themeInterval);
    } catch (e) {
      console.error("Failed to open TerminalView", e);
      this.contentEl.createEl("div", { text: "Failed to load terminal. See console for details." });
    }
  }

  async onClose() {
    if (this.themeInterval) {
      window.clearInterval(this.themeInterval);
    }
    
    if (this.bridge) {
      this.bridge.disconnect();
      this.bridge = null;
    }
    
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }
}
