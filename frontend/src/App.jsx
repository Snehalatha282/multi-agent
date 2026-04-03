import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import './App.css';

function AgentCard({ name, status, message }) {
  if (!name) return null;
  
  return (
    <div className={`agent-card ${name} fade-in`}>
      <div className="agent-header">
        <span className="agent-name">{name} Agent</span>
        <span className={`agent-status ${status}`}>
          {status}
          {status === 'thinking' && (
            <span>
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
            </span>
          )}
        </span>
      </div>
      <div className="agent-content markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {typeof message === 'object' ? JSON.stringify(message, null, 2) : message}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function App() {
  const [task, setTask] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState([]); // Array of { role: 'user', content: string } or { role: 'assistant', agents: { Planner, Executor, Critic } }
  const [currentAgents, setCurrentAgents] = useState({ Planner: null, Executor: null, Critic: null });
  const [error, setError] = useState(null);
  
  const [history, setHistory] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeHistoryId, setActiveHistoryId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  
  const [config, setConfig] = useState({
    plannerPrompt: 'You are a Planner agent. Break down the user task into 3-5 clear, concrete steps. Keep it structured.',
    executorPrompt: 'You are an Executor agent. completely execute the given plan and produce the outcome. Output the generated result comprehensively.',
    criticPrompt: 'You are a Critic agent. Review the Executor\'s output against the original task. State what is good and what is missing, then provide a finalized, improved version. Output valid JSON { "status": "pass" | "fail", "feedback": "...", "final_output": "..." }',
    model: 'llama-3.1-8b-instant'
  });

  const abortControllerRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    // Load history
    const saved = localStorage.getItem('agentHistory');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {}
    }
  }, []);

  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, currentAgents]);

  const saveHistory = (newTask, threadMessages) => {
    const newItem = { id: Date.now(), task: newTask, messages: threadMessages };
    const newHistory = [newItem, ...history];
    setHistory(newHistory);
    localStorage.setItem('agentHistory', JSON.stringify(newHistory));
  };

  const clearHistory = () => {
    if (window.confirm('Are you sure you want to clear all history?')) {
      setHistory([]);
      setMessages([]);
      setActiveHistoryId(null);
      localStorage.removeItem('agentHistory');
    }
  };

  const loadHistoryItem = (item) => {
    // New format uses 'messages', old format uses 'agents'
    if (item.messages && item.messages.length > 0) {
      setMessages(item.messages);
    } else if (item.agents || item.task) {
      // Migrate old format to a single user/assistant turn
      const legacyAgents = item.agents || {};
      // Ensure messages are not empty for old items
      setMessages([
        { role: 'user', content: item.task || 'Legacy Task' }, 
        { 
          role: 'assistant', 
          agents: {
            Planner: legacyAgents.Planner || { status: 'completed', message: 'No recorded plan.' },
            Executor: legacyAgents.Executor || { status: 'completed', message: 'No recorded execution.' },
            Critic: legacyAgents.Critic || { status: 'completed', message: 'No recorded feedback.' }
          } 
        }
      ]);
    }
    setActiveHistoryId(item.id);
    setShowSettings(false);
    setCurrentAgents({ Planner: null, Executor: null, Critic: null });
  };

  const filteredHistory = history.filter(item => {
    const term = searchTerm.toLowerCase();
    const taskMatch = item.task.toLowerCase().includes(term);
    
    const contentMatch = item.messages?.some(m => {
      if (m.content?.toLowerCase().includes(term)) return true;
      if (m.agents) {
        return Object.values(m.agents).some(a => a.message?.toLowerCase().includes(term));
      }
      return false;
    });
    
    return taskMatch || contentMatch;
  });

  const getSnippet = (item) => {
    if (!searchTerm) return null;
    const term = searchTerm.toLowerCase();
    
    // Find matching message content
    const match = item.messages?.find(m => {
      if (m.content?.toLowerCase().includes(term)) return true;
      if (m.agents) {
        return Object.values(m.agents).some(a => a.message?.toLowerCase().includes(term));
      }
      return false;
    });

    if (match) {
      let text = '';
      if (match.content?.toLowerCase().includes(term)) {
        text = match.content;
      } else if (match.agents) {
        const agentMatch = Object.values(match.agents).find(a => a.message?.toLowerCase().includes(term));
        text = agentMatch?.message || '';
      }
      const idx = text.toLowerCase().indexOf(term);
      const start = Math.max(0, idx - 40);
      return (start > 0 ? '...' : '') + text.substring(start, start + 80) + '...';
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!task.trim()) return;

    const userMessage = { role: 'user', content: task };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    const currentTask = task;
    setTask('');

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsLoading(true);
    setError(null);
    setCurrentAgents({ Planner: null, Executor: null, Critic: null });

    // Format history for backend
    const apiHistory = messages.map(m => ({
      role: m.role,
      content: m.role === 'user' ? m.content : (m.agents?.Critic?.message || 'Previous turn completed.')
    }));

    let finalAgentsState = { Planner: null, Executor: null, Critic: null };

    try {
      await fetchEventSource('http://localhost:5000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: currentTask, config, history: apiHistory }),
        signal: abortControllerRef.current.signal,
        onmessage(event) {
          if (event.event === 'end') {
            setIsLoading(false);
            const assistantMessage = { role: 'assistant', agents: finalAgentsState };
            const updatedMessages = [...newMessages, assistantMessage];
            setMessages(updatedMessages);
            saveHistory(currentTask, updatedMessages);
            setCurrentAgents({ Planner: null, Executor: null, Critic: null });
            return;
          }
          try {
            const data = JSON.parse(event.data);
            const { agent, status, message } = data;
            
            if (agent === 'System' && status === 'error') {
              setError(message);
              setIsLoading(false);
              return;
            }

            finalAgentsState = {
              ...finalAgentsState,
              [agent]: { status, message }
            };
            setCurrentAgents(finalAgentsState);
          } catch (err) {}
        },
        onerror(err) {
          setError('Connection to server lost or failed.');
          setIsLoading(false);
          throw err;
        }
      });
    } catch (err) {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">
          History
          <div className="sidebar-actions">
            <button className="icon-btn" onClick={clearHistory} title="Clear All History">🗑️</button>
            <button className="icon-btn" onClick={() => setShowSettings(!showSettings)} title="Configuration">⚙️</button>
          </div>
        </div>
        <div className="sidebar-search">
          <input 
            type="text" 
            placeholder="Search history..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="history-list">
          {filteredHistory.map(item => (
            <div 
              key={item.id} 
              className={`history-item ${activeHistoryId === item.id ? 'active' : ''}`} 
              onClick={() => loadHistoryItem(item)}
            >
              <span className="quote-icon">“</span>
              <div className="history-content-wrapper">
                <div className="history-text">{item.task}</div>
                {searchTerm && getSnippet(item) && (
                  <div className="history-snippet">{getSnippet(item)}</div>
                )}
              </div>
            </div>
          ))}
          {filteredHistory.length === 0 && (
            <div style={{color: 'var(--text-muted)', padding: '1rem', textAlign: 'center'}}>
              {searchTerm ? 'No matches found.' : 'No history yet.'}
            </div>
          )}
        </div>
      </div>

      <div className="main-content">
        <div className="main-wrapper">
          <header className="header fade-in">
            <h1>Groq Multi-Agent System</h1>
            <p style={{ color: 'var(--text-muted)' }}>Planner → Executor → Critic Workflow</p>
          </header>

          {showSettings && (
            <div className="config-panel fade-in">
              <h3>Agent Configuration</h3>
              <div className="config-item">
                <label>Model</label>
                <input type="text" className="task-input" value={config.model} onChange={e => setConfig({...config, model: e.target.value})} />
              </div>
              <div className="config-item">
                <label>Planner Prompt</label>
                <textarea value={config.plannerPrompt} onChange={e => setConfig({...config, plannerPrompt: e.target.value})} />
              </div>
              <div className="config-item">
                <label>Executor Prompt</label>
                <textarea value={config.executorPrompt} onChange={e => setConfig({...config, executorPrompt: e.target.value})} />
              </div>
            </div>
          )}

          <div className="chat-thread">
            {messages.map((msg, idx) => (
              <div key={idx} className={`message-block ${msg.role}`}>
                {msg.role === 'user' ? (
                  <div className="user-message">
                    <span className="user-avatar">👤</span>
                    <div className="message-text">{msg.content}</div>
                  </div>
                ) : (
                  <div className="agents-container">
                    <AgentCard name="Planner" {...msg.agents.Planner} />
                    <AgentCard name="Executor" {...msg.agents.Executor} />
                    <AgentCard name="Critic" {...msg.agents.Critic} />
                  </div>
                )}
              </div>
            ))}

            {isLoading && (
              <div className="message-block assistant active-turn">
                <div className="agents-container">
                  {currentAgents.Planner && <AgentCard name="Planner" {...currentAgents.Planner} />}
                  {currentAgents.Executor && <AgentCard name="Executor" {...currentAgents.Executor} />}
                  {currentAgents.Critic && <AgentCard name="Critic" {...currentAgents.Critic} />}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form className="input-section fade-in" onSubmit={handleSubmit}>
            <input 
              type="text" 
              className="task-input" 
              placeholder="Type your follows-up or a new task..."
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={isLoading}
            />
            <button type="submit" className="submit-btn" disabled={isLoading || !task.trim()}>
              {isLoading ? 'Processing...' : 'Send'}
            </button>
          </form>

          {error && <div className="system-error fade-in">{error}</div>}
        </div>
      </div>
    </div>
  );
}

export default App;
