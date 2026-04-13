import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./TerminalView";
import * as child_process from "child_process";
import * as path from "path";

export default class AgenticTerminalPlugin extends Plugin {
  sidecarProcess: child_process.ChildProcess | null = null;

  async onload() {
    this.registerView(
      VIEW_TYPE_TERMINAL,
      (leaf) => new TerminalView(leaf)
    );

    this.addCommand({
      id: "open-terminal",
      name: "Open Agentic Terminal",
      callback: () => {
        this.activateView();
      },
    });

    this.addRibbonIcon("terminal", "Open OAT", () => {
      this.activateView();
    });

    this.startSidecar();
  }

  startSidecar() {
    if (typeof process === "undefined" || !process.env) return;
    
    const adapter = this.app.vault.adapter as any;
    if (!adapter.getBasePath) return;

    const basePath = adapter.getBasePath();
    const pluginDir = path.join(basePath, ".obsidian", "plugins", "obsidian-agentic-terminal");
    const sidecarPath = path.join(pluginDir, "pty-host.js");
    const binPath = path.join(pluginDir, "node_modules", ".bin");

    const isWin = process.platform === "win32";
    const separator = isWin ? ";" : ":";

    const env = Object.assign({}, process.env, {
      OBSIDIAN_VAULT: this.app.vault.getName(),
      OBSIDIAN_VAULT_PATH: basePath,
      PATH: `${binPath}${separator}${process.env.PATH}`
    });

    try {
      this.sidecarProcess = child_process.spawn("node", [sidecarPath], { 
        env, 
        cwd: basePath,
        detached: false
      });

      this.sidecarProcess.on("error", (err) => {
        console.error("OAT Sidecar error:", err);
      });

      this.sidecarProcess.on("exit", (code) => {
        console.log(`OAT Sidecar exited with code ${code}`);
      });
    } catch (e) {
      console.error("Failed to start OAT Sidecar", e);
    }
  }

  async activateView() {
    try {
      const { workspace } = this.app;

      // Split the active leaf to create multiple terminal instances side-by-side
      const leaf = workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });
      workspace.revealLeaf(leaf);
    } catch (e) {
      console.error("OAT: Failed to activate terminal view", e);
      new Notice("Failed to open Agentic Terminal. See console for details.");
    }
  }

  onunload() {
    if (this.sidecarProcess) {
      this.sidecarProcess.kill();
    }
  }
}
