/*
 * Alma Fulfillment Rule Harvester - Chrome Extension Content Script
 *
 * Injected on every Alma page load. This persists logically across Alma
 * full-page navigations without Selenium, ChromeDriver, iframe POSTs,
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

  function getFulfillmentUnitName() {
  return cleanText(
    document.querySelector(
      "#SPAN_FORM_ID_SECTION_fulfillment\\.unit_edit\\.fulfillmentUnit_FORM_Fulfillment_Unit_INPUT_pageBeaneditedFulfillmentUnitname"
    )?.textContent
  );
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

    const headerRow =
      rows.find(row => row.querySelectorAll("th").length > 0) || rows[0];

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
            obj[`${key} Input Value`] =
              input.value || input.getAttribute("value") || "";
          }
        });

        return obj;
      })
      .filter(row =>
        Object.values(row).some(value => cleanText(value) !== "")
      );
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
      throw new Error(
        "Rules table #TABLE_DATA_rules not found. Start from the Fulfillment Unit Rules tab."
      );
    }

    const rows = [...table.querySelectorAll("tbody tr")];
    const visibleRows = tableToObjects(table);

    const rules = rows.map((row, index) => {
      const visible = visibleRows[index] || {};

      const submitInput =
        row.querySelector(`#INPUT_SELENIUM_ID_rules_ROW_${index}_COL_rulename`);

      const ruleName =
        visible["Rule Name"] ||
        cleanText(
          row.querySelector(`td[id*="_ROW_${index}_COL_rulename"]`)?.textContent
        ) ||
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
        submitValue:
          submitInput?.value || submitInput?.getAttribute("value") || ruleName
      };
    });

    console.log(`[AlmaRuleHarvester] Found ${rules.length} rules.`, rules);
    return rules;
  }

  function clickRuleByIndex(index) {
    const selector = `#INPUT_SELENIUM_ID_rules_ROW_${index}_COL_rulename`;
    const input = document.querySelector(selector);

    if (!input) {
      throw new Error(`Could not find exact rule-name submit input for row ${index}`);
    }

    console.log("[AlmaRuleHarvester] Clicking exact rule-name input", {
      index,
      id: input.id,
      name: input.name,
      value: input.value
    });

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

    const state = getState();
    const locationsString = state.locationsString || "";
    if (!detail.inputParameters?.length) {
      return [{
        sourceRuleIndex: detail.sourceRuleIndex,
        locations: locationsString,
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
      locations: locationsString,
      selectedRuleId: detail.selectedRuleId,
      ruleName: detail.ruleName,
      description: detail.description,
      outputParameter: detail.outputParameter,
      touId: detail.touId,
      parameterName:
        param.Name ||
        param.Parameter ||
        param["Column 2"] ||
        "",
      operator:
        param.Operator ||
        param["Column 3"] ||
        "",
      value:
        param.Value ||
        param["Column 4"] ||
        "",
      ...prefixObject(param, "raw_")
    }));
  }

  function scrapeRuleDetailPage() {
    const inputParameters =
      tableToObjects(document.querySelector("#TABLE_DATA_ruleParamsList"));

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
  console.log("[AlmaRuleHarvester] Attempting to return to rules page.");

  const backButton =
    document.querySelector("#PAGE_BUTTONS_cbuttonnavigationback") ||
    document.querySelector("button[name='page.buttons.operation'][value='Back']") ||
    document.querySelector("button[value='Back']") ||
    document.querySelector("#generic_back_button");

  if (!backButton) {
    throw new Error("Could not find Alma Back button.");
  }

  console.log("[AlmaRuleHarvester] Clicking real Alma Back button:", {
    id: backButton.id,
    name: backButton.name,
    value: backButton.value,
    onclick: backButton.getAttribute("onclick")
  });

  backButton.click();
}
  function toCsv(rows) {
    if (!rows?.length) return "";

    const headers = unique(rows.flatMap(row => Object.keys(row)));

    const escapeCell = value => {
      if (value == null) return "";

      const stringValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);

      return `"${stringValue.replace(/"/g, '""')}"`;
    };

    return [
      headers.map(escapeCell).join(","),
      ...rows.map(row =>
        headers.map(header => escapeCell(row[header])).join(",")
      )
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

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function downloadOutputs() {
  const state = getState();

  /*
   * Try current page first.
   * Otherwise try saved state.
   */

  let fulfillmentUnitName =
    getFulfillmentUnitName() ||
    state.fulfillmentUnitName ||
    "alma_fulfillment_unit";

  fulfillmentUnitName = sanitizeFilename(fulfillmentUnitName);

  /*
   * Persist it for later pages where the span may not exist.
   */

  state.fulfillmentUnitName = fulfillmentUnitName;
  saveState(state);

  const baseFilename =
    `alma_rule_harvest_${fulfillmentUnitName}`;

  downloadText(
    `${baseFilename}.json`,
    JSON.stringify(state, null, 2),
    "application/json"
  );

  downloadText(
    `${baseFilename}.csv`,
    toCsv(state.output || []),
    "text/csv"
  );
}

async function start() {
  clearState();

  const state = initialState();
  state.active = true;
  state.phase = "openingLocations";
  state.startedAt = nowIso();
  state.sourceRulesUrl = location.href;
  state.currentRuleIndex = 0;
  state.rules = [];
  state.locations = [];
  state.locationsString = "";
  state.fulfillmentUnitName = getFulfillmentUnitName();

  saveState(state);

  await sleep(CONFIG.delayMs);
  clickLocationsTab();
  console.log("[AlmaRuleHarvester] Started.");
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
  function clickLocationsTab() {
    const tab = document.querySelector(
      "#A_NAV_LINK_fulfillmentunit_editfulfillmentUnitLocations_span"
    );

    if (!tab) {
      throw new Error("Could not find Fulfillment Unit Locations tab.");
    }

    console.log("[AlmaRuleHarvester] Clicking Locations tab.", tab);

    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    tab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

function clickRulesTab() {
  const tab = document.querySelector(
    "#A_NAV_LINK_fulfillmentunit_editfulfillmentUnitRules_span"
  );

  if (!tab) {
    throw new Error("Could not find Fulfillment Unit Rules tab.");
  }

  console.log("[AlmaRuleHarvester] Clicking Rules tab.");
  tab.click();
}

  function scrapeLocationsList() {
    const table = document.querySelector(
      "#TABLE_DATA_fulfillmentUnitLocationsList"
    );

    if (!table) {
      throw new Error(
        "Could not find fulfillment unit locations table."
      );
    }

    /*
    * ONLY get Location Name column
    */

    const locationCells = [
      ...table.querySelectorAll(
        'td[id*="_COL_locationlocationName"]'
      )
    ];

    const locations = locationCells
      .map(td => {
        const span = td.querySelector("span");
        return cleanText(
          span?.getAttribute("title") ||
          span?.textContent
        );
      })
      .filter(Boolean);

    const uniqueLocations = [...new Set(locations)];

    const locationsString = uniqueLocations.join("; ");

    const state = getState();

    state.locations = uniqueLocations;
    state.locationsString = locationsString;

    saveState(state);

    console.log(
      "[AlmaRuleHarvester] Locations scraped:",
      uniqueLocations
    );

    return uniqueLocations;
  }
  function clickTouDetails() {
    const btn =
      document.querySelector("#uiconfiguration_rule_detailsview_tou") ||
      [...document.querySelectorAll("button, input[type='submit']")]
        .find(el => cleanText(el.value || el.textContent) === "TOU Details");

    if (!btn) {
      throw new Error("Could not find TOU Details button.");
    }

    console.log("[AlmaRuleHarvester] Clicking TOU Details.");
    btn.click();
  }

  function isTouPage() {
    return !!document.querySelector("#TABLE_DATA_policiesList");
  }

  function scrapeTouPolicies() {
    const table = document.querySelector("#TABLE_DATA_policiesList");

    if (!table) {
      throw new Error("Could not find TOU policies table.");
    }

    const rows = tableToObjects(table);
    const policyColumns = {};

    for (const row of rows) {
      const label =
        row["Policy Type"] ||
        row["Column 2"] ||
        "";

      const name =
        row["Policy Name"] ||
        row["Column 3"] ||
        "";

      const description =
        row["Policy Description"] ||
        row["Column 4"] ||
        "";

      if (!label) continue;

      policyColumns[label] = name;
      policyColumns[`${label} Description`] = description;
    }

    const state = getState();
    const currentIndex = Number(state.currentRuleIndex || 0);

    state.ruleDetails = (state.ruleDetails || []).map(detail => {
      if (Number(detail.sourceRuleIndex) !== currentIndex) return detail;

      return {
        ...detail,
        touPolicies: rows,
        touPolicyColumns: policyColumns
      };
    });

    state.output = (state.output || []).map(row => {
      if (Number(row.sourceRuleIndex) !== currentIndex) return row;

      return {
        ...row,
        ...policyColumns
      };
    });

    saveState(state);

    console.log("[AlmaRuleHarvester] Scraped TOU policies:", policyColumns);

    return policyColumns;
  }

  function isTouPage() {
    return !!document.querySelector("#TABLE_DATA_policiesList");
  }

  function scrapeTouPolicies() {
    const table = document.querySelector("#TABLE_DATA_policiesList");

    if (!table) {
      throw new Error("Could not find TOU policies table.");
    }

    const rows = tableToObjects(table);
    const policyColumns = {};

    for (const row of rows) {
      const label =
        row["Policy Type"] ||
        row["Column 2"] ||
        "";

      const name =
        row["Policy Name"] ||
        row["Column 3"] ||
        "";

      const description =
        row["Policy Description"] ||
        row["Column 4"] ||
        "";

      if (!label) continue;

      policyColumns[label] = name;
      policyColumns[`${label} Description`] = description;
    }

    const state = getState();
    const currentIndex = Number(state.currentRuleIndex || 0);

    state.ruleDetails = (state.ruleDetails || []).map(detail => {
      if (Number(detail.sourceRuleIndex) !== currentIndex) return detail;

      return {
        ...detail,
        touPolicies: rows,
        touPolicyColumns: policyColumns
      };
    });

    state.output = (state.output || []).map(row => {
      if (Number(row.sourceRuleIndex) !== currentIndex) return row;

      return {
        ...row,
        ...policyColumns
      };
    });

    saveState(state);

    console.log("[AlmaRuleHarvester] Scraped TOU policies:", policyColumns);

    return policyColumns;
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

    if (state.phase === "openingLocations") {
      console.log("[AlmaRuleHarvester] Phase: openingLocations");
      await waitForSelector("#TABLE_DATA_fulfillmentUnitLocationsList");

      scrapeLocationsList();

      state = getState();
      state.phase = "returningFromLocationsToRules";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickRulesTab();
      return;
    }

    if (state.phase === "returningFromLocationsToRules") {
      await waitForSelector("#TABLE_DATA_rules");

      const rules = scrapeRulesTable();

      state = getState();
      state.rules = rules;
      state.phase = "clickingRule";
      state.currentRuleIndex = 0;
      saveState(state);

      if (!rules.length) {
        throw new Error("No rules found after returning from Locations tab.");
      }

      await sleep(CONFIG.delayMs);
      clickRuleByIndex(0);
      return;
    }
    if (state.phase === "scrapingLocations") {
      await waitForSelector("#TABLE_DATA_fulfillmentUnitLocationsList");

      scrapeLocationsList();

      state = getState();
      state.phase = "returningFromLocationsToRules";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickRulesTab();
      return;
    }

  if (state.phase === "returningFromLocationsToRules") {
    await waitForSelector("#TABLE_DATA_rules");

    state = getState();
    state.phase = "clickingRule";
    saveState(state);

    await sleep(CONFIG.delayMs);
    clickRuleByIndex(Number(state.currentRuleIndex || 0));
    return;
  }
   if (state.phase === "clickingRule") {
  await waitForEither([
    "#TABLE_DATA_ruleParamsList",
    "#pageBeanoutputParameter",
    "#pageBeanrulename"
  ]);

  scrapeRuleDetailPage();

  state = getState();
  state.phase = "clickingTouDetails";
  saveState(state);

  await sleep(CONFIG.delayMs);
  clickTouDetails();
  return;
}

if (state.phase === "clickingTouDetails") {
  await waitForSelector("#TABLE_DATA_policiesList");

  scrapeTouPolicies();

  state = getState();
  state.phase = "returningFromTouToRule";
  saveState(state);

  await sleep(CONFIG.delayMs);
  clickBackToRules();
  return;
}

if (state.phase === "returningFromTouToRule") {
  await waitForEither([
    "#TABLE_DATA_ruleParamsList",
    "#pageBeanoutputParameter",
    "#pageBeanrulename"
  ]);

  state = getState();
  state.phase = "returningToRules";
  saveState(state);

  await sleep(CONFIG.delayMs);
  clickBackToRules();
  return;
}

    if (state.phase === "returningToRules") {
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
        handler().catch(err =>
          addError("Panel action failed", { error: String(err) })
        );
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

    el.textContent =
      `${state.phase}; ${total ? `${Math.min(idx, total)}/${total}` : "not started"}`;
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
          addError("Command failed", {
            command: message.command,
            error: String(err)
          });
          sendResponse({ ok: false, error: String(err), state: getState() });
        }
      })();

      return true;
    });
  }

  let watchdogRunning = false;
let workflowBusy = false;
let lastWorkflowSignature = "";

function installWatchdog() {
  if (watchdogRunning) return;
  watchdogRunning = true;

  setInterval(async () => {
    const state = getState();

    if (!state.active) return;
    if (workflowBusy) return;

const signature = [
  state.phase,
  state.currentRuleIndex,
  location.href,
  isRulesListPage(),
  isRuleEditorPage(),
  isTouPage()
].join("|");

    if (signature === lastWorkflowSignature) return;

    lastWorkflowSignature = signature;
    workflowBusy = true;

    try {
      console.log("[AlmaRuleHarvester] Watchdog continuing:", signature);
      await continueWorkflow();
    } catch (err) {
      console.warn("[AlmaRuleHarvester] Watchdog continue failed:", err);
    } finally {
      workflowBusy = false;
    }
  }, 2000);
}
async function boot() {
  installCommandListener();
  installFloatingPanel();
  installWatchdog();

  const state = getState();

  if (!state.active) return;

  console.log("[AlmaRuleHarvester] Active state found; watchdog will continue workflow.");
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
})()