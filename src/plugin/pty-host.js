/**
 * OAT Sidecar Process
 * This script runs as a separate Node.js process to handle node-pty.
 * It communicates with the Obsidian plugin via WebSockets.
 */

const os = require('os');
const pty = require('node-pty'); // Requires native compilation
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const { GoogleGenAI, Type } = require('@google/genai');

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

const wss = new WebSocket.Server({ port: 3001 });
const activePtys = new Set();

const subscriptions = [
  {
    id: 'sub-1',
    event: 'file_created',
    action: 'agent_prompt',
    promptTemplate: 'A new file was created at {{path}}. Give a short, 1-sentence enthusiastic acknowledgment.'
  }
];

async function handleEvent(event, payload) {
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
  console.log('Plugin connected to Sidecar');

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    // On Windows, use ConPTY
    useConpty: true
  });
  
  activePtys.add(ptyProcess);

  ptyProcess.onData((data) => {
    ws.send(JSON.stringify({ type: 'STDOUT', data }));
  });

  ws.on('message', (message) => {
    const payload = JSON.parse(message);
    
    if (payload.type === 'STDIN') {
      ptyProcess.write(payload.data);
    } else if (payload.type === 'RESIZE') {
      ptyProcess.resize(payload.cols, payload.rows);
    }
  });

  ws.on('close', () => {
    ptyProcess.kill();
    activePtys.delete(ptyProcess);
    console.log('Plugin disconnected, PTY killed');
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
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
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
        activePtys.forEach(ptyProcess => {
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
