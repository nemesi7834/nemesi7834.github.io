const config = window.PRODUCT_DAY_CONFIG;
const dashboard = document.querySelector("#dashboard");
const keyHealthGrid = document.querySelector("#key-health-grid");
const engagementFooter = document.querySelector("#engagement-footer");
const attentionSummary = document.querySelector("#attention-summary");
const template = document.querySelector("#metric-card-template");
const loginScreen = document.querySelector("#login-screen");
const appContent = document.querySelector("#app-content");
const refreshState = document.querySelector("#refresh-state");
const refreshProgress = document.querySelector("#refresh-progress");
const refreshProgressTitle = document.querySelector("#refresh-progress-title");
const refreshProgressPercent = document.querySelector("#refresh-progress-percent");
const refreshProgressBar = document.querySelector("#refresh-progress-bar");
const refreshProgressDetail = document.querySelector("#refresh-progress-detail");
const sessionKey = "product-day-session";
let session = loadSession();
let requestPoller;

const alertRules = {
  "Outdated fulfilments rate": ["higher", .2, .35, .5], "Funnel time: new → delivered": ["higher", .15, .3, 8], "Rejected fulfilments": ["higher", .2, .35, .3], "Stock-related cancellations": ["higher", .2, .35, .15], "Ops support tickets / active user": ["higher", .2, .35, .005], "Customer support tickets / active seller": ["higher", .2, .35, .03], "Funnel conversion: new → delivered": ["lower", .1, .2, 3], "VP bookings adoption": ["lower", .1, .2, 5], "Approved POs without changes": ["lower", .1, .2, 3], "FBO on-time stock availability": ["lower", .15, .3, 3], "GFR on-time stock availability": ["lower", .15, .3, 3], "Seller promo coverage": ["lower", .1, .2, 2], "SKU promo coverage": ["lower", .1, .2, 2], "VP monthly active users": ["lower", .1, .2, 100], "Seller adoption rate": ["lower", .1, .2, 3], "Average GMV per active seller": ["lower", .1, .2, .3], "GFR supplier adoption rate": ["lower", .1, .2, 3]
};
const keyMetricNames = new Set(["Funnel time: new → delivered", "Outdated fulfilments rate", "SKU promo coverage"]);

document.querySelector("#login-form").addEventListener("submit", signIn);
document.querySelector("#sign-out-button").addEventListener("click", signOut);
document.querySelector("#update-button").addEventListener("click", requestUpdate);
boot();

async function boot() {
  if (!session) return showLogin();
  try { await loadDashboard(); showDashboard(); } catch { signOut(); }
}

async function signIn(event) {
  event.preventDefault();
  const message = document.querySelector("#login-error");
  message.textContent = "";
  try {
    const response = await authRequest("/auth/v1/token?grant_type=password", { email: config.loginEmail, password: document.querySelector("#password").value });
    session = { ...response, expires_at: Date.now() + response.expires_in * 1000 };
    localStorage.setItem(sessionKey, JSON.stringify(session));
    await loadDashboard();
    showDashboard();
  } catch { message.textContent = "The password was not accepted."; }
}

function signOut() {
  session = null;
  clearInterval(requestPoller);
  localStorage.removeItem(sessionKey);
  dashboard.replaceChildren(); keyHealthGrid.replaceChildren(); engagementFooter.querySelectorAll(".section").forEach((node) => node.remove()); attentionSummary.replaceChildren();
  showLogin();
}

function showLogin() { loginScreen.hidden = false; appContent.hidden = true; document.querySelector("#password").focus(); }
function showDashboard() { loginScreen.hidden = true; appContent.hidden = false; }

async function loadDashboard() {
  const rows = await rest("/rest/v1/dashboard_snapshots?select=payload,created_at&order=created_at.desc&limit=1");
  if (!rows.length) throw new Error("No snapshot is available yet.");
  renderDashboard(rows[0].payload, rows[0].created_at);
}

async function requestUpdate() {
  const button = document.querySelector("#update-button");
  button.disabled = true; refreshState.textContent = "Requesting update…"; showRefreshProgress({ status: "queued", message: "Requesting an update…" });
  try {
    const result = await rest("/rest/v1/rpc/request_dashboard_refresh", "POST", {});
    const request = Array.isArray(result) ? result[0] : result;
    refreshState.textContent = request.status === "queued" ? "Update queued" : "Update already running";
    showRefreshProgress(request);
    watchRequest(request.id);
  } catch { refreshState.textContent = "Could not request update"; refreshProgress.hidden = true; button.disabled = false; }
}

function watchRequest(id) {
  clearInterval(requestPoller);
  const poll = async () => {
    try {
      const rows = await rest(`/rest/v1/refresh_requests?id=eq.${id}&select=status,message,requested_at,started_at,finished_at`);
      const request = rows[0];
      if (!request) return;
      showRefreshProgress(request);
      refreshState.textContent = request.status === "running" ? "Update in progress" : request.status;
      if (["completed", "skipped", "failed"].includes(request.status)) {
        clearInterval(requestPoller); document.querySelector("#update-button").disabled = false;
        if (request.status === "completed") { await loadDashboard(); refreshState.textContent = "Updated just now"; }
        if (request.status === "failed") refreshState.textContent = "Update failed";
      }
    } catch { /* retain the last visible status and retry */ }
  };
  poll();
  requestPoller = setInterval(poll, 5000);
}

function showRefreshProgress(request) {
  const state = refreshPresentation(request);
  refreshProgress.hidden = false;
  refreshProgress.dataset.status = request.status;
  refreshProgressTitle.textContent = state.title;
  refreshProgressPercent.textContent = `${state.percent}%`;
  refreshProgressBar.style.width = `${state.percent}%`;
  refreshProgress.querySelector('[role="progressbar"]').setAttribute("aria-valuenow", state.percent);
  refreshProgressDetail.textContent = state.detail;
}

function refreshPresentation(request) {
  const message = request.message || "";
  const elapsed = request.started_at || request.requested_at ? ` · ${formatElapsed(request.started_at || request.requested_at)}` : "";
  if (request.status === "completed") return { title: "Update complete", percent: 100, detail: message || "The latest dashboard snapshot is ready." };
  if (request.status === "failed") return { title: "Update did not complete", percent: 100, detail: message || "The worker did not provide an error message." };
  if (request.status === "queued") return { title: "Update queued", percent: 8, detail: "Waiting for the local worker to start. Usually less than a minute." };
  if (message.includes("step 3")) return { title: "Finishing dashboard", percent: 82, detail: `Creating the protected snapshot and checking the executive dashboard${elapsed}. Usually under a minute left.` };
  if (message.includes("step 2")) return { title: "Publishing source metrics", percent: 65, detail: `Writing validated values to Confluence${elapsed}. Usually about a minute left.` };
  return { title: "Collecting metrics", percent: 35, detail: `Getting the latest data from Jira, Metabase and Canvas${elapsed}. This is usually the longest step.` };
}

function formatElapsed(start) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(start).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
}

function renderDashboard(data, createdAt) {
  dashboard.replaceChildren(); keyHealthGrid.replaceChildren(); engagementFooter.querySelectorAll(".section").forEach((node) => node.remove());
  document.querySelector("#snapshot-date").textContent = `Updated: ${new Date(createdAt).toLocaleString("en-GB")}`;
  const analyses = data.sections.flatMap((section) => section.metrics.map(analyseMetric));
  const metrics = data.sections.flatMap((section) => section.metrics);
  renderAttentionSummary(analyses);
  metrics.filter((metric) => keyMetricNames.has(metric.name)).forEach((metric) => {
    const card = createMetricCard(metric, analyses.find((analysis) => analysis.metric === metric));
    card.classList.add("metric-card--key");
    keyHealthGrid.append(card);
  });
  data.sections.forEach((section) => {
    const destination = section.placement === "footer" ? engagementFooter : dashboard;
    const supportingMetrics = section.metrics.filter((metric) => !keyMetricNames.has(metric.name));
    if (!supportingMetrics.length) return;
    const sectionElement = document.createElement("section"); sectionElement.className = "section";
    sectionElement.innerHTML = `<h2 class="section__title">${section.title}</h2><p class="section__description">${section.description}</p>`;
    const grid = document.createElement("div"); grid.className = "card-grid";
    supportingMetrics.forEach((metric) => grid.append(createMetricCard(metric, analyses.find((analysis) => analysis.metric === metric))));
    sectionElement.append(grid); destination.append(sectionElement);
  });
}

function createMetricCard(metric, analysis) {
  const fragment = template.content.cloneNode(true); const card = fragment.querySelector(".metric-card");
  const latest = metric.history.at(-1) || { label: "No data", value: "No data" };
  card.id = metricId(metric.name);
  if (analysis.severity) { card.dataset.severity = analysis.severity; const badge = fragment.querySelector(".attention-badge"); badge.hidden = false; badge.dataset.severity = analysis.severity; badge.textContent = analysis.severity; }
  fragment.querySelector("h3").textContent = metric.name;
  const trend = fragment.querySelector(".trend-badge"); trend.textContent = metric.trend.label; trend.dataset.trend = metric.trend.kind;
  const value = fragment.querySelector(".metric-value"); value.textContent = latest.value; value.classList.toggle("is-pending", latest.status === "pending");
  fragment.querySelector(".metric-period").textContent = latest.label; fragment.querySelector(".metric-target").textContent = metric.target ? `Target: ${metric.target}` : "";
  const numeric = metric.history.filter((point) => Number.isFinite(point.numeric)); if (numeric.length > 1) fragment.querySelector(".sparkline").append(drawSparkline(numeric, metric.trend.kind));
  metric.history.slice().reverse().forEach((point) => { const item = document.createElement("li"); item.textContent = `${point.label}: ${point.value}`; fragment.querySelector(".history ul").append(item); });
  return card;
}

function analyseMetric(metric) {
  const rule = alertRules[metric.name]; const completed = metric.history.filter((point) => Number.isFinite(point.numeric) && !point.partial);
  if (!rule || completed.length < 4) return { metric, severity: null };
  const latest = completed.at(-1); const baselinePoints = completed.slice(-4, -1); const baseline = median(baselinePoints.map((point) => point.numeric));
  const adverse = rule[0] === "higher" ? (latest.numeric - baseline) / baseline : (baseline - latest.numeric) / baseline;
  const severity = adverse >= rule[2] && Math.abs(latest.numeric - baseline) >= rule[3] ? "critical" : adverse >= rule[1] && Math.abs(latest.numeric - baseline) >= rule[3] ? "warning" : null;
  return { metric, severity, latest, baselinePoints, adverseChange: adverse };
}

function renderAttentionSummary(analyses) {
  const flagged = analyses.filter((item) => item.severity).sort((a, b) => b.adverseChange - a.adverseChange);
  if (!flagged.length) { attentionSummary.innerHTML = `<div class="attention-summary__panel" data-state="clear"><div class="attention-summary__header"><h2>No unusual movement detected</h2><p>Based on the latest completed snapshots.</p></div></div>`; return; }
  const items = flagged.map((item) => { const direction = alertRules[item.metric.name][0] === "higher" ? "increase" : "drop"; return `<li><a href="#${metricId(item.metric.name)}"><span><strong>${item.metric.name} · ${item.latest.value}</strong><span>${capitalize(item.severity)} ${direction}: +${Math.round(item.adverseChange * 100)}% vs. ${item.baselinePoints.map((p) => p.label).join("–")} median</span></span><b class="severity-label" data-severity="${item.severity}">${item.severity}</b></a></li>`; }).join("");
  attentionSummary.innerHTML = `<div class="attention-summary__panel"><div class="attention-summary__header"><h2>Needs attention · ${flagged.length}</h2><p>Latest completed snapshots only.</p></div><ul class="attention-list">${items}</ul></div>`;
}

async function rest(path, method = "GET", body) {
  await refreshSessionIfNeeded();
  const response = await fetch(`${config.supabaseUrl}${path}`, { method, headers: { apikey: config.publishableKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(await response.text()); return response.status === 204 ? [] : response.json();
}
async function refreshSessionIfNeeded() { if (Date.now() < session.expires_at - 60000) return; const fresh = await authRequest("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token }); session = { ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 }; localStorage.setItem(sessionKey, JSON.stringify(session)); }
async function authRequest(path, body) { const response = await fetch(`${config.supabaseUrl}${path}`, { method: "POST", headers: { apikey: config.publishableKey, "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }
function loadSession() { try { return JSON.parse(localStorage.getItem(sessionKey)); } catch { return null; } }
function median(values) { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function metricId(name) { return `metric-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`; }
function capitalize(value) { return `${value[0].toUpperCase()}${value.slice(1)}`; }
function drawSparkline(points, trend) { const width = 220, height = 42, values = points.map((p) => p.numeric), min = Math.min(...values), max = Math.max(...values), range = max - min || 1, color = trend === "watch" ? "#bb3d3d" : trend === "down" ? "#b76b00" : "#0a8378"; const line = values.map((v, i) => `${(i / (values.length - 1) * width).toFixed(1)},${(height - 4 - (v - min) / range * (height - 10)).toFixed(1)}`).join(" "); const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.innerHTML = `<path d="M0 ${height - 3} H${width}" stroke="#e5eaed"/><polyline points="${line}" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"/>`; return svg; }
