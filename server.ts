import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Track client buffers
  const clients = new Map<WebSocket, { buffer: string }>();

  app.use(express.json());

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/v1/agent/prompt", async (req, res) => {
    try {
      const { prompt, context } = req.body;
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `You are the OAT (Obsidian Agentic Terminal) Agent. 
        The user is working in an Obsidian vault. 
        Current notes: ${context?.notes?.map((n: any) => n.name).join(", ") || "None"}.
        
        User prompt: ${prompt}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              message: { type: Type.STRING, description: "Message to display to the user" },
              action: { type: Type.STRING, description: "Action to perform: 'createNote', 'searchVault', or 'none'" },
              actionArgs: { 
                type: Type.OBJECT, 
                description: "Arguments for the action. For createNote: name, content. For searchVault: query." 
              }
            },
            required: ["message", "action"]
          }
        }
      });

      const resultText = response.text;
      if (!resultText) {
        return res.status(500).json({ error: "No response from model" });
      }

      const result = JSON.parse(resultText);
      res.json(result);
    } catch (error) {
      console.error("Agent error:", error);
      res.status(500).json({ error: "Failed to contact agent." });
    }
  });

  app.post("/api/v1/execute", (req, res) => {
    const { command } = req.body;
    // In server.ts (simulation), we just broadcast it to the websocket
    clients.forEach((state, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[35m[Agent Executing]: ${command}\x1b[0m\r\n$ ` }));
      }
    });
    res.json({ status: "executed", command });
  });

  // Event Bus & Subscriptions
  interface Subscription {
    id: string;
    event: string;
    action: string;
    promptTemplate: string;
  }
  const subscriptions: Subscription[] = [
    {
      id: 'sub-1',
      event: 'file_created',
      action: 'agent_prompt',
      promptTemplate: 'A new file was created at {{path}}. Give a short, 1-sentence enthusiastic acknowledgment.'
    }
  ];

  app.post("/api/v1/events/emit", async (req, res) => {
    const { event, payload } = req.body;
    res.json({ status: "received" });

    const subs = subscriptions.filter(s => s.event === event);
    for (const sub of subs) {
      if (sub.action === 'agent_prompt') {
        try {
          let prompt = sub.promptTemplate;
          if (payload.path) prompt = prompt.replace('{{path}}', payload.path);
          
          const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: `System: You are OAT Agent acting autonomously on an event.\nUser: ${prompt}`
          });
          
          const message = response.text;
          clients.forEach((state, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "AGENT_BROADCAST", data: message }));
            }
          });
        } catch (e) {
          console.error("Autonomous agent error:", e);
        }
      }
    }
  });

  app.post("/api/v1/subscriptions", (req, res) => {
    const sub = { id: Date.now().toString(), ...req.body };
    subscriptions.push(sub);
    res.json(sub);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // WebSocket Server for Sidecar Simulation
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("Client connected to OAT Sidecar Simulation");
    clients.set(ws, { buffer: "" });
    
    ws.send(JSON.stringify({ type: "STDOUT", data: "\r\n\x1b[32m[OAT Sidecar Simulation Started]\x1b[0m\r\n" }));
    ws.send(JSON.stringify({ type: "STDOUT", data: "Welcome to the Obsidian Agentic Terminal preview.\r\n" }));
    ws.send(JSON.stringify({ type: "STDOUT", data: "Type 'help' to see available commands.\r\n\r\n$ " }));

    ws.on("message", (message) => {
      try {
        const payload = JSON.parse(message.toString());
        const state = clients.get(ws);
        
        if (!state) return;

        if (payload.type === "STDIN") {
          const char = payload.data;
          
          if (char === "\r") {
            // Enter key pressed
            const input = state.buffer.trim();
            state.buffer = ""; // Reset buffer
            
            ws.send(JSON.stringify({ type: "STDOUT", data: "\r\n" }));
            
            if (input === "") {
              // Do nothing
            } else if (input === "help") {
              ws.send(JSON.stringify({ type: "STDOUT", data: "Available Commands:\r\n  - help: Show this message\r\n  - create [name]: Create a note in Obsidian\r\n  - search [query]: Search the vault\r\n  - agent [prompt]: Ask the OAT Agent\r\n" }));
            } else if (input.startsWith("create ")) {
              const noteName = input.replace("create ", "").trim();
              ws.send(JSON.stringify({ type: "STDOUT", data: `\x1b[34m[IPC] Creating note: ${noteName}\x1b[0m\r\n` }));
              ws.send(JSON.stringify({ type: "IPC", data: { type: "NOTIFY_FILE_CREATED", path: `${noteName}.md` } }));
            } else if (input.startsWith("search ")) {
              const query = input.replace("search ", "").trim();
              ws.send(JSON.stringify({ type: "STDOUT", data: `\x1b[36m[Search Results for '${query}']\x1b[0m\r\n  - Welcome.md (Match found in content)\r\n` }));
            } else {
              ws.send(JSON.stringify({ type: "STDOUT", data: `Command not found: ${input}\r\n` }));
            }
            
            ws.send(JSON.stringify({ type: "STDOUT", data: "$ " }));
          } else if (char === "\x7f" || char === "\b") {
            // Backspace
            if (state.buffer.length > 0) {
              state.buffer = state.buffer.slice(0, -1);
              ws.send(JSON.stringify({ type: "STDOUT", data: "\b \b" }));
            }
          } else {
            // Regular character
            state.buffer += char;
            ws.send(JSON.stringify({ type: "STDOUT", data: char }));
          }
        }
      } catch (err) {
        console.error("Error processing message:", err);
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
      clients.delete(ws);
    });
    
    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      clients.delete(ws);
    });
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
