#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = "/Users/AlekseiSereda/Codex";
const CODEX_HOME = "/Users/AlekseiSereda/.codex";
const APP_ROOT = path.join(ROOT, "ProductDay.github.io");
const CONFIG_PATH = path.join(APP_ROOT, "worker", "product-day-worker.env");
const WORKER_LOCK = path.join("/tmp", "product-day-worker.lock");
const SUPABASE_URL = "https://jcrwuejwgezsxeuznwly.supabase.co";

main().catch(async (error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  if (!claimLocalLock()) return;
  try {
    const secret = readEnv(CONFIG_PATH).PRODUCT_DAY_SUPABASE_SECRET_KEY;
    if (!secret) throw new Error("PRODUCT_DAY_SUPABASE_SECRET_KEY is missing.");
    if (process.argv.includes("--seed")) {
      await runRefreshPipeline();
      const snapshot = await buildSnapshot();
      const saved = await insertSnapshot(secret, snapshot);
      console.log(`Created initial dashboard snapshot ${saved.id}.`);
      return;
    }
    const request = await nextRequest(secret);
    if (!request) return;
    const running = await updateRequest(secret, request.id, {
      status: "running",
      started_at: new Date().toISOString(),
      message: "Collecting metrics from Jira, Metabase and Canvas (step 1 of 3)."
    });
    if (!running) return;
    try {
      await runRefreshPipeline(async (message) => updateRequest(secret, request.id, { message }));
      const snapshot = await buildSnapshot();
      const saved = await insertSnapshot(secret, snapshot);
      const summary = summarizeSnapshot(snapshot);
      await updateRequest(secret, request.id, {
        status: "completed",
        finished_at: new Date().toISOString(),
        message: `Dashboard updated successfully. ${summary.metrics} metrics refreshed; ${summary.pending} waiting for data transfer.`,
        snapshot_id: saved.id
      });
    } catch (error) {
      await updateRequest(secret, request.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        message: String(error.message || error).slice(0, 1000)
      });
      throw error;
    }
  } finally {
    releaseLocalLock();
  }
}

async function runRefreshPipeline(reportProgress = async () => {}) {
  const skill = path.join(CODEX_HOME, "skills", "sx-ops-metrics-refresh", "scripts");
  const output = "/tmp/product-day-sx-metrics.json";
  const updates = "/tmp/product-day-sx-updates.json";
  // LaunchAgents receive a minimal PATH, so use the Node binary that started
  // this worker instead of relying on a `node` command lookup.
  run(process.execPath, [path.join(skill, "collect_sx_ops_metrics.js"), "--output", output, "--updates-file", updates]);
  await reportProgress("Publishing source metrics to Confluence (step 2 of 3).");
  run("python3", [path.join(skill, "update_sx_ops_metrics_page.py"), "--updates-file", updates, "--apply"]);
  await reportProgress("Updating the executive dashboard and protected snapshot (step 3 of 3).");
  run(process.execPath, [path.join(ROOT, "scripts", "sx-ops-one-screen-dashboard.js"), "--refresh-if-needed"]);
}

function summarizeSnapshot(snapshot) {
  const metrics = snapshot.sections.flatMap((section) => section.metrics);
  return { metrics: metrics.length, pending: metrics.filter((metric) => metric.history.at(-1)?.status === "pending").length };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 20 * 60 * 1000 });
  if (result.status !== 0) {
    const details = [
      result.error?.message,
      result.signal ? `terminated by ${result.signal}` : "",
      result.stderr,
      result.stdout
    ].filter(Boolean).join("\n").trim();
    throw new Error(`${path.basename(command)} failed${result.status == null ? "" : ` (exit ${result.status})`}: ${details || "no output"}`);
  }
}

async function buildSnapshot() {
  const env = readEnv(path.join(ROOT, ".env"));
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const response = await fetch("https://hbidigital.atlassian.net/wiki/rest/api/content/8146976977?expand=body.storage,version", {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Could not read source metrics page (${response.status}).`);
  const page = await response.json();
  const cells = readMetricCells(page.body.storage.value);
  return {
    snapshotDate: new Date(page.version.when).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }),
    sourceUpdatedAt: page.version.when,
    sections: metricDefinitions().map((section) => ({
      ...section,
      metrics: section.metrics.map((definition) => ({ ...definition, history: parseHistory(cells.get(definition.sourceKey || definition.sourceName) || "") }))
    }))
  };
}

function metricDefinitions() {
  return [
    { title: "Fulfilment health", description: "Operational quality and fulfilment flow indicators.", metrics: [
      def("Outdated fulfilments rate", "Outdated fulfilments rate", "Lower is better", "down"), def("Funnel time: new → delivered", "Funnel time New → Delivered (per step)", "Better than SLA", "down"), def("Funnel conversion: new → delivered", "Funnel conversion New → Delivered (per step)", ">90%", "watch"), def("Rejected fulfilments", "% of rejected fulfilments", "<5%", "down"), def("Stock-related cancellations", "% of cancellations due to irrelevant stocks (DBS)", "<3%", "down") ] },
    { title: "Bookings & stock availability", description: "Vendor Portal booking adoption and purchase-order availability.", metrics: [
      def("VP bookings adoption", "Adoption rate", "100%", "up", "POs, Bookings & Deliveries::Adoption rate"), def("Approved POs without changes", "% of Approved PO without changes", ">90%", "watch"), def("FBO on-time stock availability", "FBO On-time stock availability", "", "up"), def("GFR on-time stock availability", "GFR On-time stock availability", "", "up") ] },
    { title: "Promotions", description: "Marketplace promotion coverage for sellers and live SKUs.", metrics: [ def("Seller promo coverage", "Seller promo coverage", "", "up"), def("SKU promo coverage", "SKU Promo coverage", "", "up") ] },
    { title: "Engagement & support", placement: "footer", description: "Product adoption and support signals from the latest confirmed monthly snapshot.", metrics: [
      def("VP monthly active users", "MAU VP", "Upward trend", "up"), def("Seller adoption rate", "Seller adoption rate", "Upward trend", "up"), def("Ops support tickets / active user", "Sellers support tickets rate (Ops scope)", "Downward trend", "down"), def("Customer support tickets / active seller", "Customer support tickets rate (sellers/products scope)", "Downward trend", "down"), def("Average GMV per active seller", "Average GMV per active seller", "Upward trend", "up") ] }
  ];
}

function def(name, sourceName, target, kind, sourceKey) { return { name, sourceName, ...(sourceKey ? { sourceKey } : {}), target, trend: { kind, label: kind === "watch" ? "data gap" : kind } }; }

function readMetricCells(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const result = new Map();
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1]);
    if (cells.length >= 4) {
      const section = toText(cells[0]);
      const metric = toText(cells[1]);
      result.set(metric, cells[3]);
      if (section) result.set(`${section}::${metric}`, cells[3]);
    }
  }
  return result;
}

function parseHistory(cellHtml) {
  const paragraphs = [...cellHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => toText(match[1]));
  return paragraphs.map((line) => {
    const match = line.match(/^(.+?)(?::|\s*=)\s*(.+)$/);
    if (!match) return null;
    const label = match[1].trim();
    const value = match[2].trim();
    const numeric = parseNumeric(value);
    return { label, value, ...(numeric == null ? {} : { numeric }), ...(isPartial(label) ? { partial: true } : {}), ...(isPending(value) ? { status: "pending" } : {}) };
  }).filter(Boolean);
}

function parseNumeric(value) {
  if (isPending(value) || /tbd|bad data|n\/a/i.test(value)) return null;
  const equals = [...value.matchAll(/=\s*([\d.]+)(?:%|hr)?/g)].at(-1);
  if (equals) return Number(equals[1]);
  const percent = value.match(/([\d.]+)%/);
  if (percent) return Number(percent[1]);
  const plain = value.match(/^\s*([\d,.]+)\s*$/);
  return plain ? Number(plain[1].replace(/,/g, "")) : null;
}

function isPending(value) { return /waiting for data transfer/i.test(value); }
function isPartial(label) { return /\(\d{1,2}\)|\d{1,2}\s+[A-Za-z]+\s*-\s*\d{1,2}\s+[A-Za-z]+/i.test(label); }
function toText(value) { return value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&rarr;/gi, "→").replace(/&ldquo;|&rdquo;/gi, '"').replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim(); }

async function nextRequest(secret) {
  const rows = await api(secret, "/rest/v1/refresh_requests?status=eq.queued&order=requested_at.asc&limit=1", "GET");
  return rows[0] || null;
}
async function updateRequest(secret, id, values) {
  const rows = await api(secret, `/rest/v1/refresh_requests?id=eq.${id}`, "PATCH", values, "return=representation");
  return rows[0];
}
async function insertSnapshot(secret, payload) {
  const rows = await api(secret, "/rest/v1/dashboard_snapshots", "POST", { source_updated_at: payload.sourceUpdatedAt, payload }, "return=representation");
  return rows[0];
}
async function api(secret, pathname, method, body, prefer) {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, { method, headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Supabase ${method} ${pathname} failed: ${await response.text()}`);
  return response.status === 204 ? [] : response.json();
}
function readEnv(file) { return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.includes("=") && !line.trim().startsWith("#")).map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, "")]; })); }
function claimLocalLock() { try { fs.writeFileSync(WORKER_LOCK, String(process.pid), { flag: "wx" }); return true; } catch { return false; } }
function releaseLocalLock() { try { fs.unlinkSync(WORKER_LOCK); } catch {} }
