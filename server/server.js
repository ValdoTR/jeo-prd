#!/usr/bin/env node
/**
 * PR Quiz Show — Minimal SSE Server
 * No dependencies beyond Node.js stdlib
 *
 * Usage: node server.js [port] [workdir]
 * Default port: 3847
 * Default workdir: current directory
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '3847', 10);
const WORKDIR = process.argv[3] || process.cwd();
const JEO_DIR = path.join(WORKDIR, '.jeo-prd');
const STATE_FILE = path.join(JEO_DIR, 'state.json');
const ANSWERS_FILE = path.join(JEO_DIR, 'answers.json');
const CONTINUE_FILE = path.join(JEO_DIR, 'continue');

// Ensure .jeo-prd directory exists with its own .gitignore
if (!fs.existsSync(JEO_DIR)) {
  fs.mkdirSync(JEO_DIR, { recursive: true });
}
const gitignorePath = path.join(JEO_DIR, '.gitignore');
if (!fs.existsSync(gitignorePath)) {
  fs.writeFileSync(gitignorePath, '*\n');
}
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let sseClients = [];
let lastActivity = Date.now();
let stateWatcher = null;
let lastStateContent = '';
let pollInterval = null;

function updateActivity() {
  lastActivity = Date.now();
}

function checkIdleTimeout() {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log('[quiz-server] Idle timeout reached, shutting down...');
    process.exit(0);
  }
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      // Validate JSON
      JSON.parse(content);
      return content;
    }
  } catch (e) {
    console.error('[quiz-server] Error reading state:', e.message);
  }
  return JSON.stringify({ phase: 'waiting', message: 'Waiting for quiz to start...' });
}

function checkAnswerReady() {
  return fs.existsSync(ANSWERS_FILE);
}

function broadcastState() {
  const content = readState();
  if (content === lastStateContent) return;

  try {
    const state = JSON.parse(content);
    console.log(`[quiz-server] State changed: phase=${state.phase}, question=${state.currentQuestion || '-'}`);
  } catch (e) {}

  lastStateContent = content;

  const data = `data: ${content}\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.write(data);
      return true;
    } catch (e) {
      return false;
    }
  });
}

function startWatching() {
  if (stateWatcher || pollInterval) return;

  const filename = 'state.json';

  try {
    stateWatcher = fs.watch(JEO_DIR, (eventType, changedFile) => {
      if (changedFile === filename) {
        updateActivity();
        setTimeout(broadcastState, 50); // debounce
      }
    });
    console.log('[quiz-server] Watching for state changes via fs.watch');
  } catch (e) {
    console.error('[quiz-server] Watch error, falling back to polling:', e.message);
  }

  // Always poll as backup - fs.watch can be unreliable
  pollInterval = setInterval(() => {
    broadcastState();
  }, 300);

  // SSE keepalive - send comment every 15s to prevent connection timeout
  setInterval(() => {
    sseClients = sseClients.filter(client => {
      try {
        client.write(': keepalive\n\n');
        return true;
      } catch (e) {
        return false;
      }
    });
  }, 15000);
}

function serveStaticFile(res, filePath, contentType) {
  try {
    const isBinary = contentType.startsWith('image/');
    const content = fs.readFileSync(filePath, isBinary ? null : 'utf8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

function handleSSE(req, res) {
  updateActivity();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send current state immediately
  const initialState = readState();
  res.write(`data: ${initialState}\n\n`);
  lastStateContent = initialState;

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
}

function handleAnswerPost(req, res) {
  updateActivity();

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const answer = JSON.parse(body);
      answer.timestamp = new Date().toISOString();
      fs.writeFileSync(ANSWERS_FILE, JSON.stringify(answer, null, 2));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: true }));
      console.log(`[quiz-server] Answer received for Q${answer.questionNumber}`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleCORS(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

const server = http.createServer((req, res) => {
  updateActivity();
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    return handleCORS(req, res);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStaticFile(res, path.join(__dirname, 'index.html'), 'text/html');
  }

  if (url.pathname === '/events') {
    return handleSSE(req, res);
  }

  if (url.pathname === '/answer' && req.method === 'POST') {
    return handleAnswerPost(req, res);
  }

  if (url.pathname === '/state') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(readState());
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // Serve host images
  if (url.pathname.startsWith('/images/')) {
    const imgPath = path.join(__dirname, url.pathname);
    return serveStaticFile(res, imgPath, 'image/png');
  }

  if (url.pathname === '/answer-ready') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({ ready: checkAnswerReady() }));
  }

  if (url.pathname === '/continue' && req.method === 'POST') {
    updateActivity();
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let content = JSON.stringify({ timestamp: Date.now() });
        if (body) {
          const data = JSON.parse(body);
          if (data.action) {
            content = JSON.stringify({ timestamp: Date.now(), action: data.action });
          }
        }
        fs.writeFileSync(CONTINUE_FILE, content);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        console.log('[quiz-server] Continue signal received:', content);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[quiz-server] PR Quiz Show UI running at http://localhost:${PORT}`);
  console.log(`[quiz-server] Working directory: ${WORKDIR}`);
  console.log(`[quiz-server] State file: ${STATE_FILE}`);
  console.log(`[quiz-server] Will auto-exit after ${IDLE_TIMEOUT_MS / 60000} minutes idle`);
  startWatching();
});

// Idle timeout check every minute
setInterval(checkIdleTimeout, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[quiz-server] Shutting down...');
  if (stateWatcher) stateWatcher.close();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  if (stateWatcher) stateWatcher.close();
  if (pollInterval) clearInterval(pollInterval);
  server.close(() => process.exit(0));
});
