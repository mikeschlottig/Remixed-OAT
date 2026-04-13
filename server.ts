import express from "express";
import "dotenv/config";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createNoteDecl = {
  name: "createNote",
  description: "Create a new note in the Obsidian vault",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: "Name of the note (including .md extension)" },
      content: { type: Type.STRING, description: "Content of the note" }
    },
    required: ["name", "content"]
  }
};

const searchVaultDecl = {
  name: "searchVault",
  description: "Search the Obsidian vault for a query",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Search query" }
    },
    required: ["query"]
  }
};

const executeCommandDecl = {
  name: "executeCommand",
  description: "Execute a shell command in the terminal",
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { type: Type.STRING, description: "The shell command to execute" }
    },
    required: ["command"]
  }
};

const listTerminalsDecl = {
  name: "listTerminals",
  description: "List all connected terminal IDs",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const sendMessageToTerminalDecl = {
  name: "sendMessageToTerminal",
  description: "Send a message to another connected terminal agent",
  parameters: {
    type: Type.OBJECT,
    properties: {
      terminalId: { type: Type.STRING, description: "The ID of the terminal to send the message to" },
      message: { type: Type.STRING, description: "The message to send" }
    },
    required: ["terminalId", "message"]
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Track client buffers
  const clients = new Map<WebSocket, { id: string, buffer: string, liveSession?: any }>();
  let nextClientId = 1;

  app.use(express.json());

  // MCP Server Setup
  const mcpServer = new McpServer({
    name: "OAT-MCP-Server",
    version: "1.0.0"
  });

  mcpServer.tool("createNote", "Create a new note in the Obsidian vault", {
    name: z.string().describe("Name of the note (including .md extension)"),
    content: z.string().describe("Content of the note")
  }, async ({ name, content }) => {
    clients.forEach((state, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "IPC", data: { type: "NOTIFY_FILE_CREATED", path: name } }));
      }
    });
    return { content: [{ type: "text", text: `Note ${name} created.` }] };
  });

  mcpServer.tool("searchVault", "Search the Obsidian vault for a query", {
    query: z.string().describe("Search query")
  }, async ({ query }) => {
    return { content: [{ type: "text", text: `Search results for ${query}:\n- Welcome.md` }] };
  });

  mcpServer.tool("executeCommand", "Execute a shell command in the terminal", {
    command: z.string().describe("The shell command to execute")
  }, async ({ command }) => {
    clients.forEach((state, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[35m[MCP Executing]: ${command}\x1b[0m\r\n$ ` }));
      }
    });
    return { content: [{ type: "text", text: `Executed command: ${command}` }] };
  });

  let mcpTransport: SSEServerTransport | null = null;

  app.get("/mcp/sse", async (req, res) => {
    mcpTransport = new SSEServerTransport("/mcp/messages", res);
    await mcpServer.connect(mcpTransport);
  });

  app.post("/mcp/messages", async (req, res) => {
    if (mcpTransport) {
      await mcpTransport.handlePostMessage(req, res);
    } else {
      res.status(500).send("MCP transport not initialized");
    }
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/v1/agent/prompt", async (req, res) => {
    try {
      const { prompt, context } = req.body;
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });
      
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
          
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });
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
    const clientId = `term-${nextClientId++}`;
    console.log(`Client connected to OAT Sidecar Simulation as ${clientId}`);
    clients.set(ws, { id: clientId, buffer: "" });
    
    ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[32m[OAT Sidecar Simulation Started - ${clientId}]\x1b[0m\r\n` }));
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
        } else if (payload.type === "START_LIVE") {
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });
          const sessionPromise = ai.live.connect({
            model: "gemini-3.1-flash-live-preview",
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }
              },
              systemInstruction: `You are the OAT Agent for terminal ${state.id}. You can execute shell commands, manage Obsidian notes, and talk to other agents. Respond conversationally.`,
              tools: [{ functionDeclarations: [createNoteDecl, searchVaultDecl, executeCommandDecl, listTerminalsDecl, sendMessageToTerminalDecl] }]
            },
            callbacks: {
              onmessage: (msg) => {
                const base64Audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                if (base64Audio) {
                  ws.send(JSON.stringify({ type: "AUDIO_OUT", data: base64Audio }));
                }
                if (msg.toolCall) {
                  const functionCalls = msg.toolCall.functionCalls;
                  if (functionCalls) {
                    const functionResponses: any[] = [];
                    for (const call of functionCalls) {
                      let result: any = { status: "ok" };
                      if (call.name === "executeCommand") {
                        const cmd = (call.args as any).command;
                        ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[35m[Agent Executing]: ${cmd}\x1b[0m\r\n$ ` }));
                        result = { status: "executed", command: cmd };
                      } else if (call.name === "createNote") {
                        const { name, content } = call.args as any;
                        ws.send(JSON.stringify({ type: "IPC", data: { type: "NOTIFY_FILE_CREATED", path: name } }));
                        result = { status: "created", name };
                      } else if (call.name === "searchVault") {
                        result = { results: ["Welcome.md"] };
                      } else if (call.name === "listTerminals") {
                        const terminalIds = Array.from(clients.values()).map(c => c.id);
                        result = { terminals: terminalIds };
                      } else if (call.name === "sendMessageToTerminal") {
                        const { terminalId, message } = call.args as any;
                        const targetClient = Array.from(clients.entries()).find(([_, c]) => c.id === terminalId);
                        if (targetClient) {
                          const [targetWs, targetState] = targetClient;
                          targetWs.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[33m[Message from ${state.id}]: ${message}\x1b[0m\r\n$ ` }));
                          if (targetState.liveSession) {
                             targetState.liveSession.then((session: any) => {
                               session.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `Message from agent ${state.id}: ${message}` }] }] } });
                             });
                          } else {
                             targetWs.send(JSON.stringify({ type: "AGENT_BROADCAST", data: `From ${state.id}: ${message}` }));
                          }
                          result = { status: "sent" };
                        } else {
                          result = { status: "error", error: "Terminal not found" };
                        }
                      }
                      functionResponses.push({
                        id: call.id,
                        name: call.name,
                        response: result
                      });
                    }
                    sessionPromise.then(session => session.sendToolResponse({ functionResponses }));
                  }
                }
              }
            }
          });
          state.liveSession = sessionPromise;
          ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[32m[Live Audio Session Started]\x1b[0m\r\n$ ` }));
        } else if (payload.type === "STOP_LIVE") {
          if (state.liveSession) {
            state.liveSession.then((session: any) => session.close());
            state.liveSession = undefined;
            ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[31m[Live Audio Session Stopped]\x1b[0m\r\n$ ` }));
          }
        } else if (payload.type === "AUDIO_IN") {
          if (state.liveSession) {
            state.liveSession.then((session: any) => {
              session.sendRealtimeInput({
                audio: { data: payload.data, mimeType: 'audio/pcm;rate=16000' }
              });
            });
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
