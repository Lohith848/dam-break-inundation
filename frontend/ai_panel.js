/**
 * ai_panel.js
 * -----------
 * AI Copilot panel for Dam Break Inundation Modeling.
 * Handles AI analysis, chat, recommendations, and report generation.
 */

// Same resolution logic as config/api.js (this file is a classic script and
// cannot use ES imports): window.__API_BASE__ override → same origin → dev fallback.
const AI_API_BASE = (() => {
  if (window.__API_BASE__) return String(window.__API_BASE__).replace(/\/+$/, "");
  const { origin, protocol, hostname } = window.location;
  if ((protocol === "http:" || protocol === "https:") && hostname === "localhost" && !origin.includes(":5500")) {
    return origin;
  }
  return "http://localhost:8000";
})();

let aiPanelOpen = false;
let currentSimId = null;
let conversationHistory = [];
let aiInitialized = false;

// ---------------------------------------------------------------------------
// 1. Panel Toggle
// ---------------------------------------------------------------------------

function toggleAIPanel() {
  const panel = document.getElementById("aiPanel");
  const toggleBtn = document.getElementById("aiToggleBtn");
  aiPanelOpen = !aiPanelOpen;

  if (aiPanelOpen) {
    panel.classList.add("open");
    toggleBtn.classList.add("panel-open");
  } else {
    panel.classList.remove("open");
    toggleBtn.classList.remove("panel-open");
  }
}

function setupAIPanel() {
  document.getElementById("aiToggleBtn").addEventListener("click", toggleAIPanel);
  document.getElementById("aiPanelClose").addEventListener("click", toggleAIPanel);

  checkAIStatus();

  // Tab switching
  document.querySelectorAll(".ai-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".ai-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".ai-tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      const tabId = "aiTab" + tab.dataset.aitab.charAt(0).toUpperCase() + tab.dataset.aitab.slice(1);
      document.getElementById(tabId).classList.add("active");
    });
  });

  // Chat input
  document.getElementById("aiChatSend").addEventListener("click", sendChatMessage);
  document.getElementById("aiChatInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });

  aiInitialized = true;
}

// ---------------------------------------------------------------------------
// 1b. AI Availability Status (reflects backend GROQ_API_KEY from .env)
// ---------------------------------------------------------------------------

async function checkAIStatus() {
  const statusEl = document.getElementById("aiStatus");
  if (!statusEl) return;
  try {
    const res = await fetch(`${AI_API_BASE}/ai/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.groq_available) {
      statusEl.innerHTML = `✅ AI Copilot ready <span style="color:var(--text-3)">(model: ${data.model})</span>`;
    } else {
      statusEl.innerHTML = `⚠️ AI disabled — add <code>GROQ_API_KEY</code> to the project <code>.env</code> file and restart the backend.`;
    }
  } catch (e) {
    statusEl.textContent = "Backend unreachable — start it with: uvicorn app.main:app --port 8000";
  }
}

// ---------------------------------------------------------------------------
// 2. Auto-Analysis After Simulation
// ---------------------------------------------------------------------------

function onSimulationComplete(simData) {
  currentSimId = simData.simulation_id;
  conversationHistory = [];

  if (!currentSimId) {
    document.getElementById("aiStatus").textContent = "No simulation ID available for AI analysis.";
    return;
  }

  document.getElementById("aiStatus").textContent = "Simulation cached. Click Analysis or Chat to begin.";

  // Clear previous results
  document.getElementById("aiOverviewContent").innerHTML = "";
  document.getElementById("aiTechnicalContent").innerHTML = "";
  document.getElementById("aiRecommendationsContent").innerHTML = "";
  document.getElementById("aiReportContent").innerHTML = "";

  // Auto-load suggested questions
  loadSuggestedQuestions();
}

// ---------------------------------------------------------------------------
// 3. AI Analysis (Overview + Technical)
// ---------------------------------------------------------------------------

async function runAIAnalysis(type) {
  if (!currentSimId) {
    alert("Run a simulation first.");
    return;
  }

  const endpoint = type === "overview" ? "/ai/analyze" : "/ai/analyze";
  const contentEl = document.getElementById(
    type === "overview" ? "aiOverviewContent" : "aiTechnicalContent"
  );

  contentEl.innerHTML = '<div class="ai-loading">Analyzing simulation data...</div>';

  try {
    const res = await fetch(`${AI_API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ simulation_id: currentSimId, language: "en" }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    contentEl.innerHTML = formatMarkdown(data.analysis);

  } catch (err) {
    contentEl.innerHTML = `<div style="color:var(--risk-crit-text)">Analysis failed: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 4. AI Recommendations
// ---------------------------------------------------------------------------

async function runAIRecommendations() {
  if (!currentSimId) {
    alert("Run a simulation first.");
    return;
  }

  const contentEl = document.getElementById("aiRecommendationsContent");
  contentEl.innerHTML = '<div class="ai-loading">Generating recommendations...</div>';

  try {
    const res = await fetch(`${AI_API_BASE}/ai/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ simulation_id: currentSimId, language: "en" }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    contentEl.innerHTML = formatMarkdown(data.recommendations);

  } catch (err) {
    contentEl.innerHTML = `<div style="color:var(--risk-crit-text)">Recommendations failed: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 5. AI Chat
// ---------------------------------------------------------------------------

async function sendChatMessage() {
  const input = document.getElementById("aiChatInput");
  const message = input.value.trim();
  if (!message) return;

  if (!currentSimId) {
    alert("Run a simulation first.");
    return;
  }

  input.value = "";

  // Add user message to chat
  addChatMessage(message, "user");

  // Add loading indicator
  const loadingEl = document.createElement("div");
  loadingEl.className = "ai-msg ai-msg-assistant ai-msg-loading";
  loadingEl.textContent = "Thinking...";
  document.getElementById("aiChatMessages").appendChild(loadingEl);
  scrollChatToBottom();

  try {
    const res = await fetch(`${AI_API_BASE}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        simulation_id: currentSimId,
        message: message,
        conversation_history: conversationHistory,
      }),
    });

    // Remove loading indicator
    loadingEl.remove();

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    addChatMessage(data.response, "assistant");

    // Update conversation history
    if (data.updated_history) {
      conversationHistory = data.updated_history;
    }

  } catch (err) {
    loadingEl.remove();
    addChatMessage(`Error: ${err.message}`, "assistant");
  }
}

function addChatMessage(text, role) {
  const container = document.getElementById("aiChatMessages");

  // Remove welcome message if present
  const welcome = container.querySelector(".ai-chat-welcome");
  if (welcome) welcome.remove();

  const msgEl = document.createElement("div");
  msgEl.className = `ai-msg ai-msg-${role}`;
  msgEl.innerHTML = formatMarkdown(text);
  container.appendChild(msgEl);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const container = document.getElementById("aiChatMessages");
  container.scrollTop = container.scrollHeight;
}

// ---------------------------------------------------------------------------
// 6. AI Report Generation
// ---------------------------------------------------------------------------

async function runAIReport() {
  if (!currentSimId) {
    alert("Run a simulation first.");
    return;
  }

  const contentEl = document.getElementById("aiReportContent");
  contentEl.innerHTML = '<div class="ai-loading">Generating report...</div>';

  try {
    const res = await fetch(`${AI_API_BASE}/ai/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ simulation_id: currentSimId, language: "en" }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    contentEl.innerHTML = `
      <div style="margin-bottom:10px;">
        <button class="btn btn-secondary" style="width:auto;padding:6px 12px;font-size:11px;" onclick="copyReportToClipboard()">
          Copy Report
        </button>
      </div>
      <div id="reportMarkdown">${formatMarkdown(data.report)}</div>
    `;
    // Store raw report for clipboard copy
    window._lastReport = data.report;

  } catch (err) {
    contentEl.innerHTML = `<div style="color:var(--risk-crit-text)">Report generation failed: ${err.message}</div>`;
  }
}

function copyReportToClipboard() {
  if (window._lastReport) {
    navigator.clipboard.writeText(window._lastReport).then(() => {
      const btn = document.querySelector("#aiReportContent .btn-secondary");
      if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy Report"; }, 2000); }
    });
  }
}

// ---------------------------------------------------------------------------
// 7. Suggested Questions
// ---------------------------------------------------------------------------

async function loadSuggestedQuestions() {
  const container = document.getElementById("aiSuggestedQuestions");
  container.innerHTML = "";

  let questions = [
    "Why is this area at risk?",
    "Which villages should evacuate first?",
    "How accurate is this prediction?",
    "Explain the flood timeline.",
  ];

  try {
    const res = await fetch(`${AI_API_BASE}/ai/suggested-questions`);
    if (res.ok) {
      const data = await res.json();
      if (data.questions && data.questions.length) {
        questions = data.questions;
      }
    }
  } catch (e) { /* use defaults */ }

  questions.forEach(q => {
    const btn = document.createElement("button");
    btn.className = "ai-suggested-q";
    btn.textContent = q;
    btn.addEventListener("click", () => {
      document.getElementById("aiChatInput").value = q;
      // Switch to chat tab
      document.querySelectorAll(".ai-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".ai-tab-content").forEach(c => c.classList.remove("active"));
      document.querySelector('.ai-tab[data-aitab="chat"]').classList.add("active");
      document.getElementById("aiTabChat").classList.add("active");
      sendChatMessage();
    });
    container.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// 8. Markdown Formatter (lightweight)
// ---------------------------------------------------------------------------

function formatMarkdown(text) {
  if (!text) return "";
  return text
    // Headers
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`(.+?)`/g, "<code>$1</code>")
    // Unordered lists
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    // Tables (basic)
    .replace(/\|(.+)\|/g, (match) => {
      const cells = match.split("|").filter(c => c.trim());
      if (cells.every(c => c.trim().match(/^[-:]+$/))) return ""; // separator row
      const tag = match.includes("---") ? "th" : "td";
      return "<tr>" + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join("") + "</tr>";
    })
    // Paragraphs
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

// ---------------------------------------------------------------------------
// 9. Wire into main app
// ---------------------------------------------------------------------------

// This is called from app.js after simulation completes
window.setupAIPanel = setupAIPanel;
window.onAISimulationComplete = onSimulationComplete;
window.runAIAnalysis = runAIAnalysis;
window.runAIRecommendations = runAIRecommendations;
window.runAIReport = runAIReport;
