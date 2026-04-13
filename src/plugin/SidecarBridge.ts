import { App, Notice } from "obsidian";
import { Terminal } from "xterm";

export class SidecarBridge {
  socket: WebSocket | null = null;
  app: App;
  terminal: Terminal;
  reconnectAttempts = 0;
  maxReconnectAttempts = 5;
  reconnectTimeout: number | null = null;

  constructor(app: App, terminal: Terminal) {
    this.app = app;
    this.terminal = terminal;
  }

  connect() {
    try {
      // In a real plugin, this would connect to the local sidecar process
      // For the preview, we connect to our simulated sidecar
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      this.socket = new WebSocket(`${protocol}//${host}`);

      this.socket.onopen = () => {
        console.log("OAT Bridge Connected");
        this.reconnectAttempts = 0;
      };

      this.socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          
          if (payload.type === "STDOUT") {
            this.terminal.write(payload.data);
          } else if (payload.type === "IPC") {
            this.handleIPC(payload.data);
          }
        } catch (e) {
          console.error("Failed to parse sidecar message", e);
        }
      };

      this.socket.onclose = () => {
        console.log("OAT Bridge Disconnected");
        this.attemptReconnect();
      };

      this.socket.onerror = (error) => {
        console.error("OAT Bridge WebSocket Error:", error);
      };
    } catch (e) {
      console.error("Failed to initialize OAT Bridge", e);
      this.attemptReconnect();
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
      console.log(`Attempting to reconnect in ${delay}ms...`);
      
      if (this.reconnectTimeout) {
        window.clearTimeout(this.reconnectTimeout);
      }
      
      this.reconnectTimeout = window.setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
      }, delay);
    } else {
      new Notice("OAT: Failed to connect to sidecar after multiple attempts.");
    }
  }

  sendStdin(data: string) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: "STDIN", data }));
      } catch (e) {
        console.error("Failed to send STDIN to sidecar", e);
      }
    }
  }

  handleIPC(data: any) {
    if (!data || !data.type) return;

    switch (data.type) {
      case "NOTIFY_FILE_CREATED":
        new Notice(`File Created: ${data.path}`);
        // In real Obsidian, we might want to open it
        // this.app.workspace.openLinkText(data.path, "", true);
        break;
      case "CREATE_FILE":
        try {
          // Native Obsidian file creation
          this.app.vault.create(data.path, data.content || "");
          new Notice(`OAT: Created file ${data.path}`);
        } catch (e: any) {
          console.error("OAT Failed to create file:", e);
          new Notice(`OAT Error creating file: ${e.message}`);
        }
        break;
      case "ERROR":
        new Notice(`OAT Error: ${data.message}`);
        break;
      default:
        console.warn("Unknown IPC message type:", data.type);
    }
  }

  disconnect() {
    if (this.reconnectTimeout) {
      window.clearTimeout(this.reconnectTimeout);
    }
    if (this.socket) {
      this.socket.onclose = null; // Prevent reconnect loop
      this.socket.close();
      this.socket = null;
    }
  }
}
