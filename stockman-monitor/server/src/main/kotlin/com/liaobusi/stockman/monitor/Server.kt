package com.liaobusi.stockman.monitor

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.routing.routing
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory

private val serverLogger = LoggerFactory.getLogger("StockManServer")

fun main() {
    serverLogger.info(
        "Starting StockMan monitor server: cwd={}, dbPath={}, logDir={}",
        java.nio.file.Path.of("").toAbsolutePath().normalize(),
        System.getProperty("stockman.db.path") ?: System.getenv("STOCKMAN_DB_PATH") ?: "<default>",
        System.getProperty("stockman.log.dir") ?: System.getenv("STOCKMAN_LOG_DIR") ?: "<default>"
    )
    embeddedServer(Netty, port = 8080, host = "0.0.0.0") {
        monitorModule()
    }.start(wait = true)
}

fun Application.monitorModule() {
    val engine = MarketEngine()
    val monitorSourceProxy = MonitorSourceProxy()

    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true })
    }
    install(CORS) {
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Get)
        allowHeader(HttpHeaders.ContentType)
        allowHost("localhost:8081")
        allowHost("127.0.0.1:8081")
    }
    routing {
        registerStatusRoutes(engine)
        registerMonitorRoutes(engine, monitorSourceProxy, serverLogger)
        registerSyncRoutes(engine, serverLogger)
        registerDebugRoutes(monitorSourceProxy, serverLogger)
        registerDatabaseRoutes(engine)
    }
}

fun dbViewerHtml(): String = """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StockMan DB Viewer</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #20242a;
      background: #f4f6f8;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    h1 { margin: 0; font-size: 28px; }
    p { margin: 6px 0 0; color: #66707c; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
    .chart {
      background: #fff;
      border: 1px solid #dfe5ec;
      border-radius: 8px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .chartBody {
      margin: 0 16px 16px;
      padding: 12px;
      border: 1px solid #edf0f4;
      border-radius: 8px;
      background: #fbfcfd;
    }
    .chart svg { width: 100%; height: 380px; display: block; }
    .chartTip {
      min-height: 30px;
      margin: 0 16px 10px;
      padding: 7px 10px;
      border-radius: 8px;
      background: #f7f9fb;
      color: #334155;
      font-size: 13px;
      font-weight: 650;
    }
    .hoverDot { opacity: 0; pointer-events: none; }
    .hit { fill: transparent; cursor: crosshair; }
    .hit:hover + .hoverDot { opacity: 1; }
    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      padding: 12px 16px;
      border-bottom: 1px solid #edf0f4;
      background: #fff;
    }
    .chartToolbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      padding: 16px;
      border-bottom: 1px solid #edf0f4;
      background: #fff;
      flex-wrap: wrap;
    }
    .chartToolbarTitle {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 180px;
    }
    .chartToolbarTitle strong {
      font-size: 16px;
    }
    .chartToolbarTitle span {
      color: #66707c;
      font-size: 13px;
    }
    .chartControls {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    .chartControls label {
      display: flex;
      flex-direction: column;
      gap: 5px;
      color: #66707c;
      font-size: 12px;
      font-weight: 700;
    }
    .chartControls input {
      width: 118px;
    }
    .chartTitle {
      min-height: 36px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      border: 1px solid #edf0f4;
      border-radius: 8px;
      background: #fbfcfd;
      color: #334155;
      font-size: 13px;
      font-weight: 700;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 13px;
      font-weight: 700;
      cursor: pointer;
      color: #20242a;
      background: #e7ebf0;
    }
    button:disabled { cursor: not-allowed; opacity: .45; }
    button.active { color: #fff; background: #20242a; }
    select, input {
      height: 36px;
      border: 1px solid #d5dce5;
      border-radius: 8px;
      padding: 0 10px;
      background: #fff;
      color: #20242a;
    }
    input { width: 88px; }
    .panel {
      background: #fff;
      border: 1px solid #dfe5ec;
      border-radius: 8px;
      overflow: auto;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid #edf0f4;
      color: #66707c;
      flex-wrap: wrap;
    }
    .tableTitleBlock {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 260px;
    }
    .tableTitleActions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    #tableName {
      color: #20242a;
      font-size: 16px;
    }
    .tableStatus,
    .syncSub {
      color: #66707c;
      font-size: 13px;
      line-height: 1.45;
    }
    .stockRefreshPanel {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .stockRefreshPanel label {
      display: flex;
      flex-direction: column;
      gap: 5px;
      color: #66707c;
      font-size: 12px;
      font-weight: 700;
    }
    .stockRefreshPanel select,
    .stockRefreshPanel input {
      width: 118px;
    }
    .refreshState {
      min-height: 36px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      border: 1px solid #edf0f4;
      border-radius: 8px;
      background: #fbfcfd;
      color: #334155;
      font-size: 13px;
      font-weight: 700;
    }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td {
      padding: 11px 10px;
      border-bottom: 1px solid #edf0f4;
      text-align: left;
      white-space: nowrap;
    }
    th { background: #f7f9fb; color: #66707c; }
    .error { color: #b42318; padding: 16px; }
    code { color: #334155; }
    .syncPanel {
      padding: 12px 16px;
      border-bottom: 1px solid #edf0f4;
      background: #fbfcfd;
    }
    .syncStats {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      color: #334155;
      font-size: 14px;
      margin-bottom: 10px;
    }
    .syncHeader {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
      width: 100%;
    }
    .syncTitleBlock {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 260px;
    }
    .syncActions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .progressTrack {
      height: 8px;
      background: #e7ebf0;
      border-radius: 999px;
      overflow: hidden;
      width: min(420px, 100%);
    }
    .progressBar {
      height: 100%;
      width: 0%;
      background: #2563eb;
    }
    .logWindow {
      height: 132px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid #dfe5ec;
      border-radius: 8px;
      background: #0f172a;
      color: #dbeafe;
      padding: 10px;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>StockMan DB Viewer</h1>
      <p id="dbPath">正在连接数据库...</p>
    </div>
  </header>
  <div class="tabs" id="tabs"></div>
  <section class="chart" id="chartSection" hidden>
    <div class="syncPanel">
      <div class="syncStats">
        <div class="syncHeader">
          <div class="syncTitleBlock">
            <strong>历史同步</strong>
            <span class="syncSub" id="historySyncSummary">正在读取历史同步状态...</span>
          </div>
          <div class="syncActions">
            <span id="historyPendingCount">待同步 -</span>
            <button id="historyIncrementalSyncButton" hidden>增量同步</button>
            <button id="historyFullSyncButton" hidden>全量同步</button>
            <button id="stopHistorySyncButton" hidden>停止</button>
          </div>
        </div>
        <span id="historyProgressText">未开始</span>
        <div class="progressTrack"><div class="progressBar" id="historyProgressBar"></div></div>
      </div>
      <div class="logWindow" id="historyLogWindow">等待同步日志...</div>
    </div>
    <div class="chartToolbar">
      <div class="chartToolbarTitle">
        <strong>日线查询</strong>
        <span>查看历史开盘/收盘走势</span>
      </div>
      <div class="chartControls">
        <label>代码 <input id="chartCode" value="688233" maxlength="6"></label>
        <label>条数 <input id="chartLimit" type="number" min="5" max="500" value="210"></label>
        <button id="loadChart">查询</button>
        <span class="chartTitle" id="chartTitle">等待查询</span>
      </div>
    </div>
    <div class="chartTip" id="chartTip"></div>
    <div class="chartBody" id="chartBody"></div>
  </section>
  <section class="panel">
    <div class="meta">
      <div class="tableTitleBlock">
        <div class="tableTitleActions">
          <strong id="tableName">-</strong>
        </div>
        <span class="tableStatus" id="tableSyncSummary">正在读取表状态...</span>
        <div class="stockRefreshPanel" id="stockRefreshPanel" hidden>
          <label>数据源
            <select id="stockRefreshSource">
              <option value="sina" selected>新浪</option>
              <option value="eastmoney">东方财富</option>
            </select>
          </label>
          <label>模式
            <select id="stockRefreshMode">
              <option value="manual" selected>手动</option>
              <option value="auto">自动</option>
            </select>
          </label>
          <label>间隔(秒)
            <input id="stockRefreshInterval" type="number" min="1" max="3600" value="10">
          </label>
          <button id="stockRefreshButton">刷新</button>
          <span class="refreshState" id="stockRefreshState">空闲</span>
        </div>
      </div>
      <span id="tableTotal">-</span>
    </div>
    <div class="toolbar">
      <button id="prevPage">上一页</button>
      <span id="pageInfo">第 - 页</span>
      <button id="nextPage">下一页</button>
      <label>每页
        <select id="pageSize">
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200" selected>200</option>
          <option value="500">500</option>
        </select>
      </label>
      <label>跳转
        <input id="pageInput" type="number" min="1" value="1">
      </label>
      <button id="jumpPage">Go</button>
    </div>
    <div id="content"></div>
  </section>
</main>
<script>
let activeTable = "";
let currentPage = 1;
let currentTotal = 0;
let historyLogLines = [];
let lastHistoryLogMessage = "";
let lastHistoryProgressKey = "";
let latestSyncStatus = null;
let latestHistorySyncStatus = null;
let stockRefreshTimer = null;
let stockRefreshRunning = false;

async function loadTables() {
  const rsp = await fetch("/api/db/tables");
  const data = await rsp.json();
  document.getElementById("dbPath").innerHTML = "SQLite: <code>" + data.database + "</code>";
  await loadSyncStatus();
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";
  const visibleTables = data.tables.filter(name => name !== "history_sync_result");
  visibleTables.forEach((name, index) => {
    const button = document.createElement("button");
    button.textContent = name;
    button.dataset.tableName = name;
    button.onclick = () => loadTable(name, 1);
    tabs.appendChild(button);
    if (index === 0) loadTable(name, 1);
  });
}

function pageSize() {
  return Number(document.getElementById("pageSize").value || 200);
}

function maxPage() {
  return Math.max(1, Math.ceil(currentTotal / pageSize()));
}

function updatePager() {
  const pages = maxPage();
  document.getElementById("pageInfo").textContent = "第 " + currentPage + " / " + pages + " 页";
  document.getElementById("pageInput").value = currentPage;
  document.getElementById("prevPage").disabled = currentPage <= 1;
  document.getElementById("nextPage").disabled = currentPage >= pages;
}

async function loadTable(name, page = currentPage) {
  activeTable = name;
  currentPage = Math.max(1, page);
  const previewTable = name === "historystock" ? "history_sync_result" : name;
  document.getElementById("chartSection").hidden = name !== "historystock";
  document.getElementById("stockRefreshPanel").hidden = name !== "stock";
  document.getElementById("historyIncrementalSyncButton").hidden = name !== "historystock";
  document.getElementById("historyFullSyncButton").hidden = name !== "historystock";
  document.getElementById("stopHistorySyncButton").hidden = name !== "historystock";
  updateStockAutoRefresh();
  document.querySelectorAll("#tabs button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tableName === name);
  });
  document.getElementById("tableName").textContent = name === "historystock" ? "history_sync_result" : name;
  updateTableSyncSummary();
  document.getElementById("tableTotal").textContent = "加载中";
  const content = document.getElementById("content");
  content.innerHTML = "";
  try {
    const limit = pageSize();
    const offset = (currentPage - 1) * limit;
    const rsp = await fetch("/api/db/table/" + encodeURIComponent(previewTable) + "?limit=" + limit + "&offset=" + offset);
    const data = await rsp.json();
    currentTotal = data.total;
    const from = data.total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + data.rows.length, data.total);
    document.getElementById("tableTotal").textContent = "共 " + data.total + " 行，当前 " + from + "-" + to;
    updatePager();
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    data.columns.forEach(column => {
      const th = document.createElement("th");
      th.textContent = column;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    data.rows.forEach(row => {
      const tr = document.createElement("tr");
      data.columns.forEach(column => {
        const td = document.createElement("td");
        td.textContent = row[column] ?? "";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    content.appendChild(table);
    if (name === "historystock") loadDailyChart().catch(() => {});
    if (name === "historystock") loadHistorySyncStatus().catch(() => {});
  } catch (error) {
    content.innerHTML = '<div class="error">' + error + '</div>';
    updatePager();
  }
}

async function loadSyncStatus() {
  const rsp = await fetch("/api/sync/status");
  latestSyncStatus = await rsp.json();
  updateTableSyncSummary();
}

function updateTableSyncSummary() {
  const tableSummary = document.getElementById("tableSyncSummary");
  if (!tableSummary) return;
  if (activeTable === "stock" && latestSyncStatus) {
    const date = formatTimestamp(latestSyncStatus.lastStockSyncTime);
    const count = latestSyncStatus.lastStockSyncCount || "-";
    const source = latestSyncStatus.lastStockSyncSource || "-";
    tableSummary.textContent = "stock " + latestSyncStatus.stockCount + " 行 · 上次实时同步 " + date + " / " + count + " 只 / " + source;
    return;
  }
  if (activeTable === "historystock" && latestHistorySyncStatus) {
    const date = latestHistorySyncStatus.lastHistorySyncDate || "-";
    const count = latestHistorySyncStatus.lastHistorySyncCount || "-";
    const stocks = latestHistorySyncStatus.lastHistorySyncStockCount || "-";
    const source = latestHistorySyncStatus.lastHistorySyncSource || "-";
    tableSummary.textContent = "预览 history_sync_result · historystock " + latestHistorySyncStatus.historyCount + " 行 · 上次历史同步 " + date + " / " + stocks + " 只 / " + count + " 行 / " + source;
    return;
  }
  tableSummary.textContent = activeTable ? "当前表预览" : "正在读取表状态...";
}

function formatTimestamp(value) {
  if (!value) return "-";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

async function loadHistorySyncStatus() {
  const rsp = await fetch("/api/sync/history/status");
  if (!rsp.ok) return;
  const data = await rsp.json();
  latestHistorySyncStatus = data;
  document.getElementById("historyPendingCount").textContent = "待同步 " + (data.pendingHistorySyncCount || 0);
  const date = data.lastHistorySyncDate || "-";
  const count = data.lastHistorySyncCount || "-";
  const stocks = data.lastHistorySyncStockCount || "-";
  const source = data.lastHistorySyncSource || "-";
  document.getElementById("historySyncSummary").textContent =
    "historystock " + data.historyCount + " 行 · 上次历史同步 " + date + " / " + stocks + " 只 / " + count + " 行 / " + source;
  updateTableSyncSummary();
}

function appendHistoryLog(message) {
  if (!message) return;
  if (message === lastHistoryLogMessage) return;
  lastHistoryLogMessage = message;
  const time = new Date().toLocaleTimeString("zh-CN");
  const line = "[" + time + "] " + message;
  historyLogLines.push(line);
  if (historyLogLines.length > 120) historyLogLines = historyLogLines.slice(historyLogLines.length - 120);
  const log = document.getElementById("historyLogWindow");
  log.textContent = historyLogLines.join("\\n");
  log.scrollTop = log.scrollHeight;
}

async function loadHistoryProgress() {
  const rsp = await fetch("/api/sync/history/progress");
  if (!rsp.ok) return;
  const data = await rsp.json();
  const total = data.total || 0;
  const completed = data.completed || 0;
  const running = data.running === true;
  const pct = total > 0 ? Math.floor(completed * 100 / total) : 0;
  document.getElementById("historyProgressText").textContent =
    (running ? "同步中" : (data.stopRequested ? "已停止" : "空闲")) +
    " · " + completed + "/" + total +
    " · 成功 " + (data.success || 0) +
    " · 失败 " + (data.failed || 0) +
    (running && data.currentCode ? " · 当前 " + data.currentCode + " " + (data.currentName || "") : "");
  document.getElementById("historyProgressBar").style.width = pct + "%";
  document.getElementById("historyIncrementalSyncButton").disabled = running;
  document.getElementById("historyFullSyncButton").disabled = running;
  document.getElementById("stopHistorySyncButton").disabled = !running || data.stopRequested;
  const progressKey = [
    data.lastMessage || "",
    data.running || false,
    data.completed || 0,
    data.success || 0,
    data.failed || 0,
    data.endedAt || ""
  ].join("|");
  if (data.lastMessage && progressKey !== lastHistoryProgressKey) {
    lastHistoryProgressKey = progressKey;
    appendHistoryLog(data.lastMessage);
  }
  if (!running && activeTable === "historystock") {
    loadHistorySyncStatus().catch(() => {});
  }
}

function renderDailyChart(data) {
  const body = document.getElementById("chartBody");
  const lines = data.lines || [];
  document.getElementById("chartTitle").textContent = data.code + " " + (data.name || "") + "，" + lines.length + " 条";
  document.getElementById("chartTip").textContent = "悬停 K 线查看开高低收、涨跌幅和均线";
  if (lines.length === 0) {
    body.innerHTML = '<div class="error">没有日线数据</div>';
    return;
  }
  const width = 1000;
  const height = 360;
  const left = 56;
  const right = 64;
  const top = 34;
  const bottom = 42;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const allPrices = [];
  lines.forEach(item => {
    allPrices.push(item.openPrice, item.closePrice, item.highest, item.lowest);
  });
  const ma = (period, index) => {
    if (index + 1 < period) return null;
    let sum = 0;
    for (let i = index - period + 1; i <= index; i += 1) sum += lines[i].closePrice;
    return sum / period;
  };
  const ma5 = lines.map((_, index) => ma(5, index));
  const ma10 = lines.map((_, index) => ma(10, index));
  const ma20 = lines.map((_, index) => ma(20, index));
  [ma5, ma10, ma20].forEach(list => list.forEach(value => { if (value != null) allPrices.push(value); }));
  const rawMin = Math.min.apply(null, allPrices);
  const rawMax = Math.max.apply(null, allPrices);
  const padding = Math.max(0.01, (rawMax - rawMin) * 0.08);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const span = Math.max(0.01, max - min);
  const step = plotW / Math.max(1, lines.length);
  const candleW = Math.max(2.5, Math.min(10, step * 0.62));
  const x = index => left + step * index + step / 2;
  const y = value => top + ((max - value) / span) * plotH;
  const maPath = (values, color) => {
    const points = values.map((value, index) => {
      if (value == null) return null;
      return x(index).toFixed(1) + "," + y(value).toFixed(1);
    }).filter(Boolean).join(" ");
    if (!points) return "";
    return '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>';
  };
  const last = lines[lines.length - 1];
  const first = lines[0];
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = max - (span * i / 4);
    const gy = y(value);
    return '<line x1="' + left + '" y1="' + gy.toFixed(1) + '" x2="' + (width - right) + '" y2="' + gy.toFixed(1) + '" stroke="#edf0f4"/>' +
      '<text x="' + (width - right + 8) + '" y="' + (gy + 4).toFixed(1) + '" fill="#66707c" font-size="11">' + value.toFixed(2) + '</text>';
  }).join("");
  const candles = lines.map((item, index) => {
    const cx = x(index);
    const up = item.closePrice >= item.openPrice;
    const color = up ? "#d92d20" : "#039855";
    const highY = y(item.highest);
    const lowY = y(item.lowest);
    const openY = y(item.openPrice);
    const closeY = y(item.closePrice);
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(1.5, Math.abs(openY - closeY));
    const fill = up ? "#fff5f3" : "#ecfdf3";
    const label = item.date + '  开 ' + item.openPrice.toFixed(2) +
      '  高 ' + item.highest.toFixed(2) +
      '  低 ' + item.lowest.toFixed(2) +
      '  收 ' + item.closePrice.toFixed(2) +
      '  涨跌 ' + item.chg.toFixed(2) + '%' +
      '  MA5 ' + (ma5[index] == null ? '-' : ma5[index].toFixed(2)) +
      '  MA10 ' + (ma10[index] == null ? '-' : ma10[index].toFixed(2)) +
      '  MA20 ' + (ma20[index] == null ? '-' : ma20[index].toFixed(2));
    return '<g>' +
      '<line x1="' + cx.toFixed(1) + '" y1="' + highY.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + lowY.toFixed(1) + '" stroke="' + color + '" stroke-width="1.2"/>' +
      '<rect x="' + (cx - candleW / 2).toFixed(1) + '" y="' + bodyY.toFixed(1) + '" width="' + candleW.toFixed(1) + '" height="' + bodyH.toFixed(1) + '" fill="' + fill + '" stroke="' + color + '" stroke-width="1.2"/>' +
      '<rect class="hit" x="' + (cx - step / 2).toFixed(1) + '" y="' + top + '" width="' + Math.max(3, step).toFixed(1) + '" height="' + plotH + '" data-label="' + label + '"></rect>' +
      '<circle class="hoverDot" cx="' + cx.toFixed(1) + '" cy="' + closeY.toFixed(1) + '" r="4" fill="' + color + '"></circle>' +
      '</g>';
  }).join("");
  const dateTicks = [
    { index: 0, anchor: "start" },
    { index: Math.floor((lines.length - 1) / 2), anchor: "middle" },
    { index: lines.length - 1, anchor: "end" }
  ].map(tick => {
    const item = lines[tick.index];
    return '<text x="' + x(tick.index).toFixed(1) + '" y="' + (height - 12) + '" fill="#66707c" font-size="11" text-anchor="' + tick.anchor + '">' + item.date + '</text>';
  }).join("");
  body.innerHTML =
    '<svg id="dailySvg" viewBox="0 0 ' + width + ' ' + height + '" role="img">' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff"/>' +
    grid +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (height - bottom) + '" stroke="#d5dce5"/>' +
    '<line x1="' + left + '" y1="' + (height - bottom) + '" x2="' + (width - right) + '" y2="' + (height - bottom) + '" stroke="#d5dce5"/>' +
    '<text x="' + left + '" y="22" fill="#20242a" font-size="13" font-weight="700">' + data.code + ' ' + (data.name || '') + '</text>' +
    '<text x="' + (width - 270) + '" y="22" fill="#20242a" font-size="13">收 ' + last.closePrice.toFixed(2) + ' / ' + last.chg.toFixed(2) + '%</text>' +
    '<text x="' + left + '" y="' + (height - 24) + '" fill="#d92d20" font-size="11">MA5</text>' +
    '<text x="' + (left + 40) + '" y="' + (height - 24) + '" fill="#f79009" font-size="11">MA10</text>' +
    '<text x="' + (left + 88) + '" y="' + (height - 24) + '" fill="#2563eb" font-size="11">MA20</text>' +
    candles +
    maPath(ma5, "#d92d20") +
    maPath(ma10, "#f79009") +
    maPath(ma20, "#2563eb") +
    dateTicks +
    '</svg>';
  const tip = document.getElementById("chartTip");
  document.querySelectorAll("#dailySvg .hit").forEach(node => {
    node.addEventListener("mouseenter", () => { tip.textContent = node.dataset.label || ""; });
    node.addEventListener("mousemove", () => { tip.textContent = node.dataset.label || ""; });
    node.addEventListener("mouseleave", () => { tip.textContent = "悬停 K 线查看开高低收、涨跌幅和均线"; });
  });
}

async function loadDailyChart() {
  const code = document.getElementById("chartCode").value.trim();
  const limit = Number(document.getElementById("chartLimit").value || 210);
  if (!code) return;
  const rsp = await fetch("/api/history/" + encodeURIComponent(code) + "?limit=" + limit);
  if (!rsp.ok) throw new Error(await rsp.text());
  renderDailyChart(await rsp.json());
}

async function refreshStockTable(trigger) {
  if (stockRefreshRunning) return;
  const button = document.getElementById("stockRefreshButton");
  const source = document.getElementById("stockRefreshSource").value || "sina";
  const state = document.getElementById("stockRefreshState");
  stockRefreshRunning = true;
  button.disabled = true;
  button.textContent = trigger === "auto" ? "自动刷新中..." : "刷新中...";
  state.textContent = (trigger === "auto" ? "自动" : "手动") + "刷新中 · " + source;
  try {
    const rsp = await fetch("/api/sync/stocks?source=" + encodeURIComponent(source), { method: "POST" });
    if (!rsp.ok) throw new Error(await rsp.text());
    latestSyncStatus = await rsp.json();
    await loadSyncStatus();
    if (activeTable) await loadTable(activeTable);
    state.textContent = "刷新成功 · " + formatTimestamp(latestSyncStatus.lastStockSyncTime);
  } catch (error) {
    state.textContent = "刷新失败 · " + error;
    if (trigger !== "auto") alert(error);
  } finally {
    stockRefreshRunning = false;
    button.disabled = false;
    button.textContent = "刷新";
  }
}

function updateStockAutoRefresh() {
  if (stockRefreshTimer != null) {
    clearInterval(stockRefreshTimer);
    stockRefreshTimer = null;
  }
  const state = document.getElementById("stockRefreshState");
  if (!state) return;
  const mode = document.getElementById("stockRefreshMode").value;
  const seconds = Math.max(1, Math.min(3600, Number(document.getElementById("stockRefreshInterval").value || 10)));
  document.getElementById("stockRefreshInterval").value = seconds;
  if (activeTable !== "stock" || mode !== "auto") {
    if (activeTable === "stock") state.textContent = "空闲";
    return;
  }
  state.textContent = "自动刷新已开启 · 每 " + seconds + " 秒";
  stockRefreshTimer = setInterval(() => {
    if (activeTable === "stock") refreshStockTable("auto");
  }, seconds * 1000);
}

document.getElementById("stockRefreshButton").onclick = () => refreshStockTable("manual");
document.getElementById("stockRefreshMode").onchange = updateStockAutoRefresh;
document.getElementById("stockRefreshInterval").onchange = updateStockAutoRefresh;
document.getElementById("stockRefreshSource").onchange = () => {
  const state = document.getElementById("stockRefreshState");
  state.textContent = "数据源已切换 · " + document.getElementById("stockRefreshSource").value;
  updateStockAutoRefresh();
};

async function startHistorySync(full) {
  const incrementalButton = document.getElementById("historyIncrementalSyncButton");
  const fullButton = document.getElementById("historyFullSyncButton");
  incrementalButton.disabled = true;
  fullButton.disabled = true;
  const button = full ? fullButton : incrementalButton;
  const originalText = button.textContent;
  button.textContent = full ? "全量同步中..." : "增量同步中...";
  try {
    const rsp = await fetch("/api/sync/history/start?full=" + (full ? "true" : "false"), { method: "POST" });
    if (!rsp.ok) throw new Error(await rsp.text());
    await rsp.json();
    lastHistoryLogMessage = "";
    lastHistoryProgressKey = "";
    appendHistoryLog(full ? "后台历史全量同步已启动" : "后台历史增量同步已启动");
    await loadHistoryProgress();
    await loadHistorySyncStatus();
  } catch (error) {
    alert(error);
    incrementalButton.disabled = false;
    fullButton.disabled = false;
  } finally {
    button.textContent = originalText;
  }
}

document.getElementById("historyIncrementalSyncButton").onclick = () => startHistorySync(false);
document.getElementById("historyFullSyncButton").onclick = () => startHistorySync(true);

document.getElementById("stopHistorySyncButton").onclick = async () => {
  const button = document.getElementById("stopHistorySyncButton");
  button.disabled = true;
  try {
    const rsp = await fetch("/api/sync/history/stop", { method: "POST" });
    if (!rsp.ok) throw new Error(await rsp.text());
    appendHistoryLog("已发送停止请求");
    await loadHistoryProgress();
  } catch (error) {
    alert(error);
  }
};

document.getElementById("loadChart").onclick = () => {
  loadDailyChart().catch(error => {
    document.getElementById("chartBody").innerHTML = '<div class="error">' + error + '</div>';
  });
};

document.getElementById("prevPage").onclick = () => {
  if (activeTable && currentPage > 1) loadTable(activeTable, currentPage - 1);
};

document.getElementById("nextPage").onclick = () => {
  if (activeTable && currentPage < maxPage()) loadTable(activeTable, currentPage + 1);
};

document.getElementById("jumpPage").onclick = () => {
  if (!activeTable) return;
  const target = Number(document.getElementById("pageInput").value || 1);
  loadTable(activeTable, Math.min(Math.max(1, target), maxPage()));
};

document.getElementById("pageSize").onchange = () => {
  if (activeTable) loadTable(activeTable, 1);
};

setInterval(() => {
  loadHistoryProgress().catch(() => {});
  if (activeTable === "historystock") loadSyncStatus().catch(() => {});
}, 1000);

loadTables();
loadHistoryProgress().catch(() => {});
loadHistorySyncStatus().catch(() => {});
</script>
</body>
</html>
""".trimIndent()
