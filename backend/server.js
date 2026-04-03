import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Groq } from 'groq-sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 5000;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });


const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for real-time information and news.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_local_file",
      description: "Save content into a file. Use relative paths like './logs/result.txt'.",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "The path where the file will be saved" },
          content: { type: "string", description: "The text content to write" }
        },
        required: ["filepath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate a mathematical expression precisely.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "The math expression (e.g. '(5+5)*2')" }
        },
        required: ["expression"]
      }
    }
  }
];

async function executeToolCall(toolCall) {
  const args = JSON.parse(toolCall.function.arguments);
  try {
    if (toolCall.function.name === 'search_wikipedia') {
      const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(args.query)}&utf8=&format=json`);
      const data = await res.json();
      return data.query.search.slice(0, 3).map(r => r.snippet.replace(/<\/?[^>]+(>|$)/g, "")).join("... ") || "No results.";
    } 
    
    if (toolCall.function.name === 'web_search') {
      const response = await axios.get(`https://duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const $ = cheerio.load(response.data);
      const results = [];
      $('.result__body').slice(0, 5).each((i, el) => {
        const title = $(el).find('.result__title').text().trim();
        const snippet = $(el).find('.result__snippet').text().trim();
        results.push(`${title}: ${snippet}`);
      });
      return results.join("\n\n") || "No web results found.";
    }

    if (toolCall.function.name === 'read_local_file') {
      return fs.readFileSync(args.filepath, 'utf-8');
    } 
    
    if (toolCall.function.name === 'write_local_file') {
      const dir = path.dirname(args.filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(args.filepath, args.content, 'utf-8');
      return `File successfully wrote to: ${args.filepath}`;
    } 
    
    if (toolCall.function.name === 'calculator') {
      const result = new Function(`return ${args.expression}`)();
      return `Result: ${result}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
  return "Unknown tool";
}

app.post('/api/chat', async (req, res) => {
  const { task, config, history = [] } = req.body;
  
  if (!task) return res.status(400).json({ error: 'Task is required' });
  const MODEL = config?.model || 'llama-3.1-8b-instant';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (agent, status, message) => {
    res.write(`data: ${JSON.stringify({ agent, status, message })}\n\n`);
  };

  try {
    // Inject conversation memory (limit to last 6 messages to stay under limits)
    const formattedHistory = history.slice(-6).map(item => ({
      role: item.role,
      content: item.content
    }));

    // 1. Planner Agent
    sendEvent('Planner', 'thinking', 'Analyzing task and formulating plan...');
    const plannerPrompt = config?.plannerPrompt || 'You are a Planner agent...';
    
    const plannerCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: plannerPrompt + " Always focus on the user's latest message while considering context." }, 
        ...formattedHistory,
        { role: 'user', content: task }
      ],
      model: MODEL,
    });
    const plan = plannerCompletion.choices[0]?.message?.content || '';
    sendEvent('Planner', 'completed', plan);

    // Feedback Loop State
    let executionResult = '';
    let criticPassed = false;
    let retries = 0;
    const MAX_RETRIES = 3;
    let executorMessages = [
      { role: 'system', content: (config?.executorPrompt || 'You are an Executor agent.') + " Use the provided tools and output NATIVE tool calls only. Never generate manual tags like '<function=' yourself." },
      ...formattedHistory,
      { role: 'user', content: `Original Task: ${task}\n\nPlan to execute:\n${plan}` }
    ];

    while (!criticPassed && retries < MAX_RETRIES) {
      sendEvent('Executor', 'thinking', `Simulating execution (Attempt ${retries + 1}/${MAX_RETRIES})...`);
      
      const executorCompletion = await groq.chat.completions.create({
        messages: executorMessages,
        model: MODEL,
        tools: tools,
        tool_choice: "auto"
      });

      const responseMessage = executorCompletion.choices[0]?.message;
      executorMessages.push(responseMessage);
      
      if (responseMessage.tool_calls) {
        sendEvent('Executor', 'thinking', `Processing tools...`);
        for (const toolCall of responseMessage.tool_calls) {
          const toolResult = await executeToolCall(toolCall);
          executorMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolResult
          });
        }
        
        const secondExecutorCompletion = await groq.chat.completions.create({
          messages: executorMessages,
          model: MODEL
        });
        executionResult = secondExecutorCompletion.choices[0]?.message?.content || '';
        executorMessages.push(secondExecutorCompletion.choices[0]?.message);
      } else {
        executionResult = responseMessage.content || '';
      }
      
      sendEvent('Executor', 'completed', executionResult);

      // 3. Critic Agent
      sendEvent('Critic', 'thinking', 'Evaluating execution results (Strict Config)...');
      
      const criticPrompt = config?.criticPrompt || 'You are a Critic agent. Output valid JSON { "status": "pass" | "fail", "feedback": "...", "final_output": "..." }';
      
      const criticCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: criticPrompt }, 
          ...formattedHistory,
          { role: 'user', content: `Original Task: ${task}\n\nExecutor Output:\n${executionResult}` }
        ],
        model: MODEL,
        response_format: { type: "json_object" }
      });
      
      let criticResult;
      try {
        criticResult = JSON.parse(criticCompletion.choices[0]?.message?.content || '{}');
      } catch(e) {
        criticResult = { status: "fail", feedback: "Failed to parse JSON string from critic.", final_output: executionResult };
      }

      if (criticResult.status === 'pass' || retries === MAX_RETRIES - 1) {
        criticPassed = true;
        sendEvent('Critic', 'completed', `### Status: ${criticResult.status ? criticResult.status.toUpperCase() : 'UNKNOWN'}\n\n**Feedback:** ${criticResult.feedback}\n\n**Final Polish:**\n\n${criticResult.final_output}`);
      } else {
        sendEvent('Critic', 'error', `### CRITIC REJECTED (Retry ${retries + 1})\n\n**Feedback:** ${criticResult.feedback}`);
        executorMessages.push({
           role: 'user', 
           content: `The Critic rejected your output. Feedback: ${criticResult.feedback}. Please completely rewrite output fixing these issues.`
        });
        retries++;
      }
    }

    res.write('event: end\ndata: {}\n\n');
    res.end();
  } catch (error) {
    console.error(error);
    sendEvent('System', 'error', 'An error occurred during multi-agent execution: ' + error.message);
    res.write('event: end\ndata: {}\n\n');
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
