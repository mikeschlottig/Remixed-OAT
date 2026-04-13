import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { 
  Terminal as TerminalIcon, 
  FileText, 
  Search, 
  Settings, 
  Cpu, 
  BookOpen, 
  Send,
  Plus,
  X,
  Columns
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Terminal Component
function TerminalPane({ 
  id, 
  onClose, 
  setNotes,
  setAgentOutput
}: { 
  id: number; 
  onClose: (id: number) => void;
  setNotes: React.Dispatch<React.SetStateAction<{ name: string; content: string }[]>>;
  setAgentOutput: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#1a1a1a",
        foreground: "#d4d4d4",
      },
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 14,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    
    // Defer fitting to ensure DOM has painted and dimensions are available
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch (e) {
        console.warn("Failed to fit terminal on mount", e);
      }
    });

    xtermRef.current = term;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "STDOUT") {
        term.write(payload.data);
      } else if (payload.type === "IPC") {
        if (payload.data.type === "NOTIFY_FILE_CREATED") {
          setNotes(prev => [...prev, { name: payload.data.path, content: "# New Note\nCreated via OAT." }]);
        }
      } else if (payload.type === "AGENT_BROADCAST") {
        setAgentOutput(`[Autonomous] ${payload.data}`);
      }
    };

    term.onData((data) => {
      socket.send(JSON.stringify({ type: "STDIN", data }));
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch (e) {
        // Ignore resize errors if terminal is hidden or unmounted
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      socket.close();
      term.dispose();
    };
  }, [setNotes]);

  return (
    <div className="flex-1 flex flex-col bg-[#1a1a1a] border-r border-[#333] last:border-r-0 min-w-[300px]">
      <div className="flex bg-[#141414] border-b border-[#333] justify-between items-center pr-2">
        <div className="px-4 py-2 bg-[#1a1a1a] border-r border-[#333] text-xs flex items-center gap-2 border-t-2 border-t-purple-500">
          <TerminalIcon size={12} />
          powershell
        </div>
        <button onClick={() => onClose(id)} className="text-[#555] hover:text-red-400 p-1 rounded hover:bg-[#222]">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 p-4 overflow-hidden relative">
        <div ref={terminalRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// Main App
export default function App() {
  const [activeTab, setActiveTab] = useState("terminal");
  const [notes, setNotes] = useState<{ name: string; content: string }[]>([
    { name: "Welcome.md", content: "# Welcome to OAT\nThis is a simulated Obsidian environment." }
  ]);
  const [terminals, setTerminals] = useState<number[]>([1]);
  const [nextTermId, setNextTermId] = useState(2);
  const [isAgentThinking, setIsAgentThinking] = useState(false);
  const [agentOutput, setAgentOutput] = useState<string | null>(null);

  const handleSplitPane = () => {
    setTerminals(prev => [...prev, nextTermId]);
    setNextTermId(prev => prev + 1);
  };

  const handleClosePane = (id: number) => {
    setTerminals(prev => prev.filter(t => t !== id));
  };

  const handleAgentPrompt = async (prompt: string) => {
    setIsAgentThinking(true);
    setAgentOutput(null);
    try {
      const response = await fetch("/api/v1/agent/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, context: { notes } })
      });
      
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      
      const data = await response.json();
      
      if (data.action === "createNote" && data.actionArgs) {
        const { name, content } = data.actionArgs;
        setNotes(prev => [...prev, { name, content }]);
        setAgentOutput(`Created note: ${name}\n\n${data.message}`);
        try {
          await fetch("/api/v1/events/emit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "file_created", payload: { path: name } })
          });
        } catch (e) { console.error(e); }
      } else if (data.action === "searchVault" && data.actionArgs) {
        const { query } = data.actionArgs;
        const results = notes.filter(n => n.name.includes(query) || n.content.includes(query));
        setAgentOutput(`Searched for '${query}'. Found ${results.length} results.\n\n${data.message}`);
      } else {
        setAgentOutput(data.message || "No response from agent.");
      }
    } catch (error) {
      setAgentOutput("Failed to contact agent.");
    } finally {
      setIsAgentThinking(false);
    }
  };

  return (
    <div className="flex h-screen bg-[#0f0f0f] text-[#d4d4d4] font-sans overflow-hidden">
      {/* Sidebar */}
      <div className="w-16 bg-[#1a1a1a] border-r border-[#333] flex flex-col items-center py-4 gap-6 z-10">
        <div className="p-2 bg-[#333] rounded-lg text-purple-400">
          <Cpu size={24} />
        </div>
        <div className="flex flex-col gap-4 mt-4">
          <SidebarIcon icon={<FileText size={20} />} active={activeTab === "notes"} onClick={() => setActiveTab("notes")} />
          <SidebarIcon icon={<TerminalIcon size={20} />} active={activeTab === "terminal"} onClick={() => setActiveTab("terminal")} />
          <SidebarIcon icon={<Search size={20} />} active={activeTab === "search"} onClick={() => setActiveTab("search")} />
          <SidebarIcon icon={<BookOpen size={20} />} active={activeTab === "rag"} onClick={() => setActiveTab("rag")} />
        </div>
        <div className="mt-auto">
          <SidebarIcon icon={<Settings size={20} />} />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 border-b border-[#333] bg-[#1a1a1a] flex items-center px-4 justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold tracking-widest text-[#888] uppercase">Obsidian Agentic Terminal</span>
            <span className="px-2 py-0.5 bg-purple-900/30 text-purple-400 text-[10px] rounded border border-purple-500/30">PREVIEW</span>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={handleSplitPane}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#333] hover:bg-[#444] text-[#d4d4d4] text-xs rounded-md transition-colors font-medium"
            >
              <Columns size={14} />
              Split Pane
            </button>
            <button 
              onClick={() => alert("In a real app, this would download the plugin .zip file containing manifest.json, main.js, and styles.css.")}
              className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs rounded-md transition-colors font-medium"
            >
              <Plus size={14} />
              Install Plugin
            </button>
          </div>
        </header>

        {/* Workspace */}
        <div className="flex-1 flex overflow-hidden">
          {/* File Explorer (Simulated) */}
          <div className="w-64 bg-[#141414] border-r border-[#333] flex flex-col shrink-0">
            <div className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-wider">Vault Explorer</div>
            <div className="flex-1 overflow-y-auto p-2">
              {notes.map((note, i) => (
                <div key={i} className="flex items-center gap-2 p-2 hover:bg-[#222] rounded cursor-pointer text-sm group">
                  <FileText size={14} className="text-[#888]" />
                  <span className="flex-1 truncate">{note.name}</span>
                  <X 
                    size={12} 
                    className="opacity-0 group-hover:opacity-100 text-[#555] hover:text-red-400" 
                    onClick={(e) => {
                      e.stopPropagation();
                      setNotes(prev => prev.filter((_, idx) => idx !== i));
                    }}
                  />
                </div>
              ))}
              <button 
                onClick={async () => {
                  const newName = `Untitled ${notes.length}.md`;
                  setNotes(prev => [...prev, { name: newName, content: "" }]);
                  try {
                    await fetch("/api/v1/events/emit", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ event: "file_created", payload: { path: newName } })
                    });
                  } catch (e) { console.error(e); }
                }}
                className="w-full mt-2 p-2 border border-dashed border-[#333] rounded text-[#555] hover:text-[#888] hover:border-[#444] flex items-center justify-center gap-2 text-xs transition-colors"
              >
                <Plus size={14} /> New Note
              </button>
            </div>
          </div>

          {/* Terminal Area */}
          <div className="flex-1 flex flex-col bg-[#1a1a1a] min-w-0 relative">
            
            {/* Split Panes Container */}
            <div className="flex-1 flex overflow-x-auto">
              {terminals.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-[#555]">
                  No terminals open. Click "Split Pane" to open one.
                </div>
              ) : (
                terminals.map(id => (
                  <TerminalPane key={id} id={id} onClose={handleClosePane} setNotes={setNotes} setAgentOutput={setAgentOutput} />
                ))
              )}
            </div>

            {/* Agent Overlay */}
            <AnimatePresence>
              {(isAgentThinking || agentOutput) && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute bottom-24 right-8 bg-[#222] border border-purple-500/30 p-4 rounded-lg shadow-2xl flex flex-col gap-2 max-w-sm z-20"
                >
                  <div className="flex items-center gap-2 border-b border-[#333] pb-2">
                    <Cpu size={14} className="text-purple-400" />
                    <span className="text-xs font-bold text-[#888] uppercase tracking-wider">OAT Agent</span>
                    {isAgentThinking && <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse ml-auto"></div>}
                  </div>
                  <span className="text-sm text-[#d4d4d4]">
                    {isAgentThinking ? "Thinking..." : agentOutput}
                  </span>
                  {!isAgentThinking && (
                    <button 
                      onClick={() => setAgentOutput(null)}
                      className="absolute top-2 right-2 text-[#555] hover:text-[#888]"
                    >
                      <X size={14} />
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Agent Input Bar */}
            <div className="p-4 bg-[#141414] border-t border-[#333] shrink-0">
              <div className="max-w-3xl mx-auto relative">
                <input 
                  type="text" 
                  placeholder="Ask the OAT Agent (e.g. 'Create a note called Project.md' or 'Search for Welcome')"
                  className="w-full bg-[#1a1a1a] border border-[#333] rounded-full py-3 px-6 pr-12 text-sm focus:outline-none focus:border-purple-500/50 transition-colors"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.currentTarget.value.trim()) {
                      handleAgentPrompt(e.currentTarget.value);
                      e.currentTarget.value = "";
                    }
                  }}
                />
                <button className="absolute right-4 top-1/2 -translate-y-1/2 text-[#555] hover:text-purple-400 transition-colors">
                  <Send size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarIcon({ icon, active = false, onClick }: { icon: React.ReactNode, active?: boolean, onClick?: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`p-2 rounded-lg transition-all duration-200 ${
        active 
          ? "bg-purple-500/20 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.2)]" 
          : "text-[#555] hover:text-[#888] hover:bg-[#222]"
      }`}
    >
      {icon}
    </button>
  );
}
