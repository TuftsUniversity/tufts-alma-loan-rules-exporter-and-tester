import os, zipfile, json

base = "/mnt/data/alma-rule-harvester-extension"
os.makedirs(base, exist_ok=True)

manifest = {
    "manifest_version": 3,
    "name": "Alma Fulfillment Rule Harvester",
    "version": "1.0.0",
    "description": "Harvests Alma fulfillment unit rules by clicking rule rows, scraping input/output parameters, and exporting CSV/JSON.",
    "permissions": ["storage", "downloads", "activeTab"],
    "host_permissions": ["https://*.alma.exlibrisgroup.com/*"],
    "content_scripts": [
        {
            "matches": ["https://*.alma.exlibrisgroup.com/*"],
            "js": ["content.js"],
            "run_at": "document_idle"
        }
    ],
    "action": {
        "default_title": "Alma Rule Harvester",
        "default_popup": "popup.html"
    }
}

content_js = r'''
/*
 * Alma Fulfillment Rule Harvester - Chrome Extension Content Script
 *
 * Injected on every Alma page load. This lets the script persist logically
 * across Alma full-page navigations without Selenium, ChromeDriver, iframe POSTs,
 * or reconstructed /ng/page URLs.
 *
 * Start from the Fulfillment Unit Rules page:
 *   window.AlmaRuleHarvester.start()
 *
 * Or use the extension popup / floating panel.
 */

(() => {
  if (window.__almaRuleHarvesterLoaded) return;
  window.__almaRuleHarvesterLoaded = true;

  const STORAGE_KEY = "almaRuleHarvesterStateV1";

  const CONFIG = {
    delayMs: 900,
    maxWaitMs: 30000,
    autoDownloadOnComplete: true
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
  }

  function initialState() {
    return {
      version: 1,
      active: false,
      phase: "idle",
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      currentRuleIndex: 0,
      sourceRulesUrl: "",
      lastUrl: "",
      rules: [],
      ruleDetails: [],
      output: [],
      warnings: [],
      errors: []
    };
  }

  function getState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? { ...initialState(), ...JSON.parse(raw) } : initialState();
    } catch (err) {
      console.warn("[AlmaRuleHarvester] Could not parse state:", err);
      return initialState();
    }
  }

  function saveState(state) {
    state.updatedAt = nowIso();
    state.lastUrl = location.href;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    updateFloatingPanel();
  }

  function clearState() {
    sessionStorage.removeItem(STORAGE_KEY);
    updateFloatingPanel();
    console.log("[AlmaRuleHarvester] State cleared.");
  }

  function addWarning(message, extra = {}) {
    const state = getState();
    state.warnings.push({ message, extra, at: nowIso(), url: location.href });
    saveState(state);
    console.warn("[AlmaRuleHarvester]", message, extra);
  }

  function addError(message, extra = {}) {
    const state = getState();
    state.errors.push({ message, extra, at: nowIso(), url: location.href });
    saveState(state);
    console.error("[AlmaRuleHarvester]", message, extra);
  }

  async function waitForSelector(selector, timeout = CONFIG.maxWaitMs) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(250);
    }

    throw new Error(`Timed out waiting for ${selector}`);
  }

  async function waitForEither(selectors, timeout = CONFIG.maxWaitMs) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) return { selector, el };
      }
      await sleep(250);
    }

    throw new Error(`Timed out waiting for one of: ${selectors.join(", ")}`);
  }

  function dedupeHeaders(headers) {
    const counts = {};
    return headers.map(header => {
      const base = header || "Column";
      counts[base] = (counts[base] || 0) + 1;
      return counts[base] === 1 ? base : `${base} ${counts[base]}`;
    });
  }

  function tableToObjects(table) {
    if (!table) return [];

    const rows = [...table.querySelectorAll("tr")];
    if (!rows.length) return [];

    const headerRow = rows.find(row => row.querySelectorAll("th").length > 0) || rows[0];

    let headers = [...headerRow.querySelectorAll("th, td")]
      .map((cell, index) => cleanText(cell.textContent) || `Column ${index + 1}`);

    headers = dedupeHeaders(headers);

    const startIndex = rows.indexOf(headerRow) + 1;

    return rows.slice(startIndex)
      .map(row => {
        const cells = [...row.querySelectorAll("td, th")];
        const obj = {};

        cells.forEach((cell, index) => {
          const key = headers[index] || `Column ${index + 1}`;
          obj[key] = cleanText(cell.textContent);

          const input = cell.querySelector("input, select, textarea");
          if (input) {
            obj[`${key} Input Name`] = input.getAttribute("name") || "";
            obj[`${key} Input Id`] = input.getAttribute("id") || "";
            obj[`${key} Input Value`] = input.value || input.getAttribute("value") || "";
          }
        });

        return obj;
      })
      .filter(row => Object.values(row).some(value => cleanText(value) !== ""));
  }

  function isRulesListPage() {
    return !!document.querySelector("#TABLE_DATA_rules");
  }

  function isRuleEditorPage() {
    return !!(
      document.querySelector("#TABLE_DATA_ruleParamsList") ||
      document.querySelector("#pageBeanrulename") ||
      document.querySelector("#pageBeanoutputParameter")
    );
  }

  function scrapeRulesTable() {
    const table = document.querySelector("#TABLE_DATA_rules");

    if (!table) {
      throw new Error("Rules table #TABLE_DATA_rules not found. Start from the Fulfillment Unit Rules tab.");
    }

    const rows = [...table.querySelectorAll("tbody tr")];
    const visibleRows = tableToObjects(table);

    const rules = rows.map((row, index) => {
      const visible = visibleRows[index] || {};

      const submitInput =
        row.querySelector(`#INPUT_SELENIUM_ID_rules_ROW_${index}_COL_rulename`) ||
        row.querySelector(`td[id*="_ROW_${index}_COL_rulename"] input[type="submit"]`);

      const ruleName =
        visible["Rule Name"] ||
        cleanText(row.querySelector(`td[id*="_ROW_${index}_COL_rulename"]`)?.textContent) ||
        cleanText(submitInput?.value);

      return {
        index,
        ruleName,
        output: visible.Output || "",
        updatedBy: visible["Updated By"] || "",
        updateDate: visible["Update Date"] || "",
        visible,
        submitSelector: submitInput?.id ? `#${cssEscape(submitInput.id)}` : "",
        submitName: submitInput?.getAttribute("name") || "",
        submitValue: submitInput?.value || submitInput?.getAttribute("value") || ruleName
      };
    });

    console.log(`[AlmaRuleHarvester] Found ${rules.length} rules.`, rules);
    return rules;
  }

  function clickRuleByIndex(index) {
    const input =
      document.querySelector(`#INPUT_SELENIUM_ID_rules_ROW_${index}_COL_rulename`) ||
      document.querySelector(`td[id*="_ROW_${index}_COL_rulename"] input[type="submit"]`);

    if (!input) {
      throw new Error(`Could not find hidden rule submit input for row ${index}.`);
    }

    console.log(`[AlmaRuleHarvester] Clicking rule ${index + 1}:`, input.value || input.title || input.id);

    /*
     * Use the actual Alma control so Alma's own loadPage(this) machinery runs.
     */
    input.click();
  }

  function getRuleName() {
    return cleanText(document.querySelector("#pageBeanrulename")?.textContent);
  }

  function getRuleDescription() {
    return cleanText(document.querySelector("#pageBeanruledescription")?.textContent);
  }

  function getOutputParameter() {
    return cleanText(document.querySelector("#pageBeanoutputParameter")?.textContent);
  }

  function extractFromHaystacks(patterns) {
    const haystacks = [
      location.href,
      document.documentElement.outerHTML,
      document.querySelector("[name='pageBean.currentUrl']")?.value || ""
    ];

    for (const text of haystacks) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1];
      }
    }

    return "";
  }

  function extractSelectedRuleIdFromCurrentPage() {
    return extractFromHaystacks([
      /pageBean\.selectedRuleId[=:"'\s]+(\d+)/i,
      /pageBean\.selectedRuleId%3D(\d+)/i,
      /selectedRuleId[=:"'\s]+(\d+)/i,
      /selectedRuleId%3D(\d+)/i
    ]);
  }

  function extractTouIdFromCurrentPage() {
    return extractFromHaystacks([
      /pageBean\.touId[=:"'\s]+(\d+)/i,
      /pageBean\.touId%3D(\d+)/i,
      /touId[=:"'\s]+(\d+)/i,
      /touId%3D(\d+)/i
    ]);
  }

  function prefixObject(obj, prefix) {
    const out = {};
    for (const [key, value] of Object.entries(obj || {})) {
      out[`${prefix}${key}`] = value;
    }
    return out;
  }

  function flattenRuleDetail(detail) {
    if (!detail.inputParameters?.length) {
      return [{
        sourceRuleIndex: detail.sourceRuleIndex,
        selectedRuleId: detail.selectedRuleId,
        ruleName: detail.ruleName,
        description: detail.description,
        outputParameter: detail.outputParameter,
        touId: detail.touId,
        parameterName: "",
        operator: "",
        value: ""
      }];
    }

    return detail.inputParameters.map(param => ({
      sourceRuleIndex: detail.sourceRuleIndex,
      selectedRuleId: detail.selectedRuleId,
      ruleName: detail.ruleName,
      description: detail.description,
      outputParameter: detail.outputParameter,
      touId: detail.touId,
      parameterName: param.Name || param.Parameter || param["Column 2"] || "",
      operator: param.Operator || param["Column 3"] || "",
      value: param.Value || param["Column 4"] || "",
      ...prefixObject(param, "raw_")
    }));
  }

  function scrapeRuleDetailPage() {
    const inputParameters = tableToObjects(document.querySelector("#TABLE_DATA_ruleParamsList"));

    const detail = {
      scrapedAt: nowIso(),
      sourceRuleIndex: getState().currentRuleIndex,
      selectedRuleId: extractSelectedRuleIdFromCurrentPage(),
      ruleName: getRuleName(),
      description: getRuleDescription(),
      outputParameter: getOutputParameter(),
      touId: extractTouIdFromCurrentPage(),
      ruleUrl: location.href,
      inputParameters
    };

    const rows = flattenRuleDetail(detail);
    const state = getState();

    state.ruleDetails = [
      ...(state.ruleDetails || []).filter(d => d.sourceRuleIndex !== detail.sourceRuleIndex),
      detail
    ].sort((a, b) => Number(a.sourceRuleIndex) - Number(b.sourceRuleIndex));

    state.output = [
      ...(state.output || []).filter(r => r.sourceRuleIndex !== detail.sourceRuleIndex),
      ...rows
    ].sort((a, b) => Number(a.sourceRuleIndex) - Number(b.sourceRuleIndex));

    saveState(state);

    console.log("[AlmaRuleHarvester] Scraped rule detail:", detail);
    return detail;
  }

  function clickBackToRules() {
    const back =
      document.querySelector("#PAGE_BUTTONS_cbuttonnavigationback") ||
      document.querySelector("#generic_back_button");

    if (!back) {
      throw new Error("Could not find Alma Back button.");
    }

    console.log("[AlmaRuleHarvester] Clicking Back.");
    back.click();
  }

  function toCsv(rows) {
    if (!rows?.length) return "";

    const headers = unique(rows.flatMap(row => Object.keys(row)));

    const escapeCell = value => {
      if (value == null) return "";
      const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
      return `"${stringValue.replace(/"/g, '""')}"`;
    };

    return [
      headers.map(escapeCell).join(","),
      ...rows.map(row => headers.map(header => escapeCell(row[header])).join(","))
    ].join("\n");
  }

  function downloadText(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadOutputs() {
    const state = getState();

    downloadText(
      "alma-rule-harvest.json",
      JSON.stringify(state, null, 2),
      "application/json"
    );

    downloadText(
      "alma-rule-harvest.csv",
      toCsv(state.output || []),
      "text/csv"
    );
  }

  async function start() {
    clearState();

    await waitForSelector("#TABLE_DATA_rules");

    const rules = scrapeRulesTable();

    const state = initialState();
    state.active = true;
    state.phase = "clickingRule";
    state.startedAt = nowIso();
    state.sourceRulesUrl = location.href;
    state.currentRuleIndex = 0;
    state.rules = rules;

    saveState(state);

    if (!rules.length) {
      throw new Error("No rules found.");
    }

    await sleep(CONFIG.delayMs);
    clickRuleByIndex(0);
  }

  async function stop() {
    const state = getState();
    state.active = false;
    state.phase = "stopped";
    saveState(state);
    console.log("[AlmaRuleHarvester] Stopped.");
  }

  async function resume() {
    const state = getState();

    if (!state.active) {
      console.log("[AlmaRuleHarvester] Not active. Nothing to resume.");
      return;
    }

    await continueWorkflow();
  }

  async function continueWorkflow() {
    let state = getState();

    console.log("[AlmaRuleHarvester] Continue workflow:", {
      phase: state.phase,
      currentRuleIndex: state.currentRuleIndex,
      isRulesListPage: isRulesListPage(),
      isRuleEditorPage: isRuleEditorPage(),
      url: location.href
    });

    if (!state.active) return;

    if (state.phase === "clickingRule" && isRuleEditorPage()) {
      await waitForEither(["#TABLE_DATA_ruleParamsList", "#pageBeanoutputParameter", "#pageBeanrulename"]);

      scrapeRuleDetailPage();

      state = getState();
      state.phase = "returningToRules";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickBackToRules();
      return;
    }

    if (state.phase === "returningToRules" && isRulesListPage()) {
      await waitForSelector("#TABLE_DATA_rules");

      state = getState();

      const nextIndex = Number(state.currentRuleIndex || 0) + 1;
      state.currentRuleIndex = nextIndex;

      if (nextIndex >= state.rules.length) {
        state.phase = "complete";
        state.active = false;
        state.completedAt = nowIso();
        saveState(state);

        console.log("[AlmaRuleHarvester] Complete.", state);

        if (CONFIG.autoDownloadOnComplete) {
          downloadOutputs();
        }

        return;
      }

      state.phase = "clickingRule";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickRuleByIndex(nextIndex);
      return;
    }

    if (state.phase === "clickingRule" && isRulesListPage()) {
      await waitForSelector("#TABLE_DATA_rules");
      await sleep(CONFIG.delayMs);
      clickRuleByIndex(Number(state.currentRuleIndex || 0));
      return;
    }

    if (state.phase === "returningToRules" && isRuleEditorPage()) {
      await sleep(CONFIG.delayMs);
      clickBackToRules();
      return;
    }

    console.log("[AlmaRuleHarvester] No matching continuation branch.");
  }

  function status() {
    const state = getState();
    console.log("[AlmaRuleHarvester] Status:", state);
    return state;
  }

  function installFloatingPanel() {
    if (document.querySelector("#alma-rule-harvester-panel")) return;

    const panel = document.createElement("div");
    panel.id = "alma-rule-harvester-panel";
    panel.style.position = "fixed";
    panel.style.zIndex = "2147483647";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    panel.style.background = "#fff";
    panel.style.border = "1px solid #777";
    panel.style.borderRadius = "8px";
    panel.style.padding = "8px";
    panel.style.fontFamily = "Arial, sans-serif";
    panel.style.fontSize = "12px";
    panel.style.boxShadow = "0 2px 10px rgba(0,0,0,0.25)";
    panel.style.maxWidth = "280px";

    const title = document.createElement("div");
    title.textContent = "Alma Rule Harvester";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "6px";
    panel.appendChild(title);

    const statusLine = document.createElement("div");
    statusLine.id = "alma-rule-harvester-status";
    statusLine.style.marginBottom = "6px";
    panel.appendChild(statusLine);

    const mkButton = (label, handler) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.marginRight = "4px";
      btn.style.marginBottom = "4px";
      btn.addEventListener("click", () => {
        handler().catch(err => addError("Panel action failed", { error: String(err) }));
      });
      return btn;
    };

    panel.appendChild(mkButton("Start", start));
    panel.appendChild(mkButton("Resume", resume));
    panel.appendChild(mkButton("Stop", stop));
    panel.appendChild(mkButton("Download", async () => downloadOutputs()));
    panel.appendChild(mkButton("Clear", async () => clearState()));

    document.body.appendChild(panel);

    updateFloatingPanel();
    setInterval(updateFloatingPanel, 1500);
  }

  function updateFloatingPanel() {
    const el = document.querySelector("#alma-rule-harvester-status");
    if (!el) return;

    const state = getState();
    const total = state.rules?.length || 0;
    const idx = Number(state.currentRuleIndex || 0) + 1;

    el.textContent = `${state.phase}; ${total ? `${Math.min(idx, total)}/${total}` : "not started"}`;
  }

  function installCommandListener() {
    if (!chrome?.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.target !== "alma-rule-harvester") return false;

      (async () => {
        try {
          if (message.command === "start") await start();
          if (message.command === "resume") await resume();
          if (message.command === "stop") await stop();
          if (message.command === "download") downloadOutputs();
          if (message.command === "clear") clearState();

          sendResponse({ ok: true, state: getState() });
        } catch (err) {
          addError("Command failed", { command: message.command, error: String(err) });
          sendResponse({ ok: false, error: String(err), state: getState() });
        }
      })();

      return true;
    });
  }

  async function boot() {
    installCommandListener();
    installFloatingPanel();

    await sleep(CONFIG.delayMs);

    const state = getState();

    if (state.active) {
      continueWorkflow().catch(err => addError("Auto-continue failed", { error: String(err) }));
    }
  }

  window.AlmaRuleHarvester = {
    start,
    stop,
    resume,
    status,
    clearState,
    downloadOutputs,
    continueWorkflow,
    tableToObjects
  };

  boot().catch(err => addError("Boot failed", { error: String(err) }));

  console.log("[AlmaRuleHarvester] Content script loaded.");
})();
'''

popup_html = r'''
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Alma Rule Harvester</title>
  <style>
    body { font-family: Arial, sans-serif; min-width: 260px; padding: 10px; }
    h1 { font-size: 16px; margin: 0 0 8px 0; }
    button { margin: 3px; padding: 6px 8px; }
    #status {
      white-space: pre-wrap;
      background: #f4f4f4;
      border: 1px solid #ddd;
      padding: 6px;
      margin-top: 8px;
      font-size: 12px;
      max-height: 180px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <h1>Alma Rule Harvester</h1>
  <div>
    <button id="start">Start</button>
    <button id="resume">Resume</button>
    <button id="stop">Stop</button>
    <button id="download">Download</button>
    <button id="clear">Clear</button>
  </div>
  <div id="status">Open an Alma Fulfillment Unit Rules page, then click Start.</div>
  <script src="popup.js"></script>
</body>
</html>
'''

popup_js = r'''
async function sendCommand(command) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    setStatus("No active tab.");
    return;
  }

  chrome.tabs.sendMessage(
    tab.id,
    { target: "alma-rule-harvester", command },
    response => {
      if (chrome.runtime.lastError) {
        setStatus("Error: " + chrome.runtime.lastError.message);
        return;
      }

      if (!response) {
        setStatus("No response from content script. Make sure the current tab is Alma.");
        return;
      }

      setStatus(JSON.stringify(response, null, 2));
    }
  );
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

document.getElementById("start").addEventListener("click", () => sendCommand("start"));
document.getElementById("resume").addEventListener("click", () => sendCommand("resume"));
document.getElementById("stop").addEventListener("click", () => sendCommand("stop"));
document.getElementById("download").addEventListener("click", () => sendCommand("download"));
document.getElementById("clear").addEventListener("click", () => sendCommand("clear"));
'''

readme = r'''
# Alma Fulfillment Rule Harvester Chrome Extension

This extension automates harvesting Alma Fulfillment Unit Rules without Selenium or ChromeDriver.

It works by injecting a content script on every Alma page load. The content script:
1. Starts on the Fulfillment Unit Rules page.
2. Scrapes the visible rules table.
3. Clicks the real hidden Alma submit input for rule row 0.
4. On the rule editor page, scrapes:
   - rule name
   - description
   - input parameter table
   - output parameter / TOU name
5. Clicks Alma's real Back button.
6. Repeats for the next rule.
7. Downloads `alma-rule-harvest.json` and `alma-rule-harvest.csv`.

## Install locally

1. Unzip this folder.
2. Open Chrome.
3. Go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select this folder.

## Use

1. Log into Alma.
2. Navigate to the Fulfillment Unit Rules page for the fulfillment unit you want to export.
3. Click the extension icon.
4. Click **Start**.

A small floating control panel also appears in the Alma page.

## Why this avoids the 404 problem

This extension does not reconstruct `/ng/page;u=...` URLs and does not use hidden iframe POSTs. It clicks Alma's real hidden submit inputs and real Back button, so Alma's own UI code performs the correct navigation.
'''

files = {
    "manifest.json": json.dumps(manifest, indent=2),
    "content.js": content_js.strip() + "\n",
    "popup.html": popup_html.strip() + "\n",
    "popup.js": popup_js.strip() + "\n",
    "README.md": readme.strip() + "\n"
}

for name, content in files.items():
    with open(os.path.join(base, name), "w", encoding="utf-8") as f:
        f.write(content)

zip_path = "/mnt/data/alma-rule-harvester-extension.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for name in files:
        z.write(os.path.join(base, name), arcname=f"alma-rule-harvester-extension/{name}")

print(zip_path)
