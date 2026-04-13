/**
 * OAT Sidecar Process
 * This script runs as a separate Node.js process to handle node-pty.
 * It communicates with the Obsidian plugin via WebSockets.
 */

const os = require('os');
require('dotenv').config();
const pty = require('node-pty'); // Requires native compilation
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const { GoogleGenAI, Type, Modality } = require('@google/genai');

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

const wss = new WebSocket.Server({ port: 3001 });
const activePtys = new Map();
let nextClientId = 1;

const subscriptions = [
  {
    id: 'sub-1',
    event: 'file_created',
    action: 'agent_prompt',
    promptTemplate: 'A new file was created at {{path}}. Give a short, 1-sentence enthusiastic acknowledgment.'
  }
];

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

async function handleEvent(event, payload) {
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
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "AGENT_BROADCAST", data: message }));
          }
        });
      } catch (e) {
        console.error("Autonomous agent error:", e);
      }
    }
  }
}

try {
  fs.watch(process.cwd(), (eventType, filename) => {
    if (filename && eventType === 'rename') {
      fs.access(filename, fs.constants.F_OK, (err) => {
        if (!err) {
          handleEvent('file_created', { path: filename });
        }
      });
    }
  });
} catch (e) {
  console.error("Failed to start watcher:", e);
}

wss.on('connection', (ws) => {
  const clientId = `term-${nextClientId++}`;
  console.log(`Plugin connected to Sidecar as ${clientId}`);

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    // On Windows, use ConPTY
    useConpty: true
  });
  
  activePtys.set(clientId, ptyProcess);
  ws.clientId = clientId;

  let liveSession = null;

  ptyProcess.onData((data) => {
    ws.send(JSON.stringify({ type: 'STDOUT', data }));
  });

  ws.on('message', (message) => {
    const payload = JSON.parse(message);
    
    if (payload.type === 'STDIN') {
      ptyProcess.write(payload.data);
    } else if (payload.type === 'RESIZE') {
      ptyProcess.resize(payload.cols, payload.rows);
    } else if (payload.type === 'START_LIVE') {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });
      liveSession = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }
          },
          systemInstruction: `You are the OAT Agent for terminal ${clientId}. You can execute shell commands, manage Obsidian notes, and talk to other agents. Respond conversationally.`,
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
                const functionResponses = [];
                for (const call of functionCalls) {
                  let result = { status: "ok" };
                  if (call.name === "executeCommand") {
                    const cmd = call.args.command;
                    ptyProcess.write(cmd + '\r');
                    result = { status: "executed", command: cmd };
                  } else if (call.name === "createNote") {
                    const { name, content } = call.args;
                    fs.writeFileSync(name, content);
                    result = { status: "created", name };
                  } else if (call.name === "searchVault") {
                    result = { results: ["Search not fully implemented in sidecar yet"] };
                  } else if (call.name === "listTerminals") {
                    result = { terminals: Array.from(activePtys.keys()) };
                  } else if (call.name === "sendMessageToTerminal") {
                    const { terminalId, message } = call.args;
                    let targetWs = null;
                    wss.clients.forEach(client => {
                      if (client.clientId === terminalId && client.readyState === WebSocket.OPEN) {
                        targetWs = client;
                      }
                    });
                    if (targetWs) {
                      targetWs.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[33m[Message from ${clientId}]: ${message}\x1b[0m\r\n$ ` }));
                      if (targetWs.liveSession) {
                        targetWs.liveSession.then(session => {
                          session.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `Message from agent ${clientId}: ${message}` }] }] } });
                        });
                      } else {
                        targetWs.send(JSON.stringify({ type: "AGENT_BROADCAST", data: `From ${clientId}: ${message}` }));
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
                liveSession.then(session => session.sendToolResponse({ functionResponses }));
              }
            }
          }
        }
      });
      ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[32m[Live Audio Session Started]\x1b[0m\r\n$ ` }));
      ws.liveSession = liveSession;
    } else if (payload.type === 'STOP_LIVE') {
      if (liveSession) {
        liveSession.then(session => session.close());
        liveSession = null;
        ws.liveSession = null;
        ws.send(JSON.stringify({ type: "STDOUT", data: `\r\n\x1b[31m[Live Audio Session Stopped]\x1b[0m\r\n$ ` }));
      }
    } else if (payload.type === 'AUDIO_IN') {
      if (liveSession) {
        liveSession.then(session => {
          session.sendRealtimeInput({
            audio: { data: payload.data, mimeType: 'audio/pcm;rate=16000' }
          });
        });
      }
    }
  });

  ws.on('close', () => {
    ptyProcess.kill();
    if (liveSession) {
      liveSession.then(session => session.close());
    }
    activePtys.delete(clientId);
    console.log(`Plugin disconnected, PTY killed for ${clientId}`);
  });
});

// IPC Server for CLI Agents to send commands to Obsidian
const ipcServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ipc') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        // Broadcast to all connected WS clients (Obsidian plugin)
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'IPC', data: payload }));
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } else if (req.method === 'POST' && req.url === '/api/v1/agent/prompt') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { prompt, context } = JSON.parse(body);
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });
        
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `You are the OAT (Obsidian Agentic Terminal) Agent. 
          The user is working in an Obsidian vault. 
          Current notes: ${context?.notes?.map(n => n.name).join(", ") || "None"}.
          
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
          res.writeHead(500);
          res.end(JSON.stringify({ error: "No response from model" }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(resultText);
      } catch (e) {
        console.error("Agent error:", e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Failed to contact agent." }));
      }
    });
  } else if (req.method === 'POST' && req.url === '/api/v1/execute') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const { command } = JSON.parse(body);
        activePtys.forEach((ptyProcess, id) => {
          ptyProcess.write(command + '\r');
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'executed', command }));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } else if (req.method === 'POST' && req.url === '/api/v1/events/emit') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const { event, payload } = JSON.parse(body);
        handleEvent(event, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'received' }));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } else if (req.method === 'POST' && req.url === '/api/v1/subscriptions') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const sub = { id: Date.now().toString(), ...JSON.parse(body) };
        subscriptions.push(sub);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sub));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

ipcServer.listen(3002, () => {
  console.log('OAT IPC listening on port 3002');
});

console.log('OAT Sidecar listening on port 3001');
