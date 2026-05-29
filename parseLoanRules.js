/*
 * Alma Fulfillment Rule Harvester
 * Hidden iframe version with corrected /ng/page;u= URL construction
 *
 * Run from Chrome DevTools while logged into Alma and already on the
 * Fulfillment Unit Rules page.
 *
 * Run:
 *
 *   await AlmaFulfillmentNavigator.harvestRules()
 *
 * This version:
 *   - stays on the rules page
 *   - submits each rule action in a hidden iframe
 *   - parses returned rule editor HTML
 *   - harvests input parameters and output parameter / TOU name
 *   - downloads JSON + CSV
 *
 * Important:
 *   This avoids building malformed URLs like:
 *     /ng/page;u=%2Fful%2Faction%2FpageAction.do%3F&xmlFileName...
 *
 *   All inner Alma pageAction params are encoded inside the u= value.
 */

(() => {
  const STORAGE_KEY = "almaFulfillmentIframeHarvesterStateV2";

  const DEFAULT_CONFIG = {
    delayMs: 500,
    iframeTimeoutMs: 45000,
    downloadOnComplete: true,

    /*
     * If true, the script tries to POST to the visible Alma form action.
     * If false, it builds a clean /ng/page;u=... URL for the rules page.
     *
     * Leave false based on your 404 problem.
     */
    useVisibleFormAction: false
  };

  // ============================================================
  // Utilities
  // ============================================================

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

  function dedupeHeaders(headers) {
    const counts = {};

    return headers.map(header => {
      const base = header || "Column";
      counts[base] = (counts[base] || 0) + 1;
      return counts[base] === 1 ? base : `${base} ${counts[base]}`;
    });
  }

  function prefixObject(obj, prefix) {
    const out = {};

    for (const [key, value] of Object.entries(obj || {})) {
      out[`${prefix}${key}`] = value;
    }

    return out;
  }

  function pageHtml(root = document) {
    return root.documentElement ? root.documentElement.outerHTML : "";
  }

  // ============================================================
  // State
  // ============================================================

  function initialState() {
    return {
      version: 2,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      sourceUrl: location.href,
      config: { ...DEFAULT_CONFIG },
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
      console.warn("Could not parse saved state.", err);
      return initialState();
    }
  }

  function saveState(state) {
    state.updatedAt = nowIso();
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clearState() {
    sessionStorage.removeItem(STORAGE_KEY);
    console.log("Cleared harvester state.");
  }

  function getConfig() {
    return {
      ...DEFAULT_CONFIG,
      ...(getState().config || {})
    };
  }

  function setConfig(config) {
    const state = getState();
    state.config = {
      ...getConfig(),
      ...config
    };
    saveState(state);
    console.log("Config updated:", state.config);
  }

  function addWarning(message, extra = {}) {
    const state = getState();
    state.warnings.push({
      message,
      extra,
      at: nowIso(),
      url: location.href
    });
    saveState(state);
    console.warn(message, extra);
  }

  function addError(message, extra = {}) {
    const state = getState();
    state.errors.push({
      message,
      extra,
      at: nowIso(),
      url: location.href
    });
    saveState(state);
    console.error(message, extra);
  }

  // ============================================================
  // Correct Alma /ng/page URL building
  // ============================================================

  function makeNgPageUrl(innerPath, params) {
    const innerQuery = new URLSearchParams(params).toString();
    const innerUrl = `${innerPath}?${innerQuery}`;
    return `${location.origin}/ng/page;u=${encodeURIComponent(innerUrl)}`;
  }

  function parseInnerUFromCurrentUrl() {
    try {
      const current = new URL(location.href);
      const u = current.searchParams.get("u");
      if (!u) return null;

      return decodeURIComponent(u);
    } catch {
      return null;
    }
  }

  function getParamFromText(text, names) {
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const patterns = [
        new RegExp(`${escaped}=([^&"'<>\\s]+)`, "i"),
        new RegExp(`${escaped}%3D([^%&"'<>\\s]+)`, "i"),
        new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']+)["']`, "i"),
        new RegExp(`value=["']([^"']+)["'][^>]*name=["']${escaped}["']`, "i")
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return decodeURIComponent(match[1]);
      }
    }

    return "";
  }

  function getWizardId() {
    const html = document.documentElement.outerHTML;

    const navBack =
      document.querySelector("[name='pageBean.navigationBackUrl']")?.value || "";

    const currentInner =
      parseInnerUFromCurrentUrl() || "";

    return (
      getParamFromText(navBack, ["wizardId"]) ||
      getParamFromText(currentInner, ["wizardId"]) ||
      getParamFromText(html, ["wizardId"]) ||
      ""
    );
  }

  function getStepName() {
    const navBack =
      document.querySelector("[name='pageBean.navigationBackUrl']")?.value || "";

    const currentInner =
      parseInnerUFromCurrentUrl() || "";

    return (
      getParamFromText(navBack, ["stepName"]) ||
      getParamFromText(currentInner, ["stepName"]) ||
      "fulfillment.unit_edit.fulfillmentUnitRules"
    );
  }

  function getRulesPageUrl() {
    const wizardId = getWizardId();
    const stepName = getStepName();

    if (!wizardId) {
      addWarning("Could not determine wizardId. URL may fail.");
    }

    return makeNgPageUrl("/ful/action/pageAction.do", {
      xmlFileName: "fulfillmentUnits.fulfillment_unit_rules.xml",
      almaConfiguration: "true",
      wizardId,
      pageViewMode: "Edit",
      stepName
    });
  }

function getFormPostAction(originalForm) {
  return new URL(
    originalForm.getAttribute("action") || "/ful/action/pageAction.do",
    location.origin
  ).href;
}

  // ============================================================
  // Wait helpers
  // ============================================================

  async function waitForSelector(selector, root = document, timeout = 30000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(250);
    }

    throw new Error(`Timed out waiting for selector: ${selector}`);
  }

  // ============================================================
  // Table parsing
  // ============================================================

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

          const input = cell.querySelector("input");
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

  // ============================================================
  // Rules table scraping
  // ============================================================

  function scrapeRulesTable() {
    const table = document.querySelector("#TABLE_DATA_rules");

    if (!table) {
      throw new Error(
        "Could not find #TABLE_DATA_rules. Run this from the Alma rules page."
      );
    }

    const rows = [...table.querySelectorAll("tbody tr")];
    const visibleRows = tableToObjects(table);

    const rules = rows.map((row, index) => {
      const visible = visibleRows[index] || {};

      const submitInput =
        row.querySelector(`#INPUT_SELENIUM_ID_rules_ROW_${index}_COL_rulename`) ||
        row.querySelector(
          `td[id*="_ROW_${index}_COL_rulename"] input[type="submit"]`
        );

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
        submitName: submitInput?.getAttribute("name") || "",
        submitValue:
          submitInput?.value || submitInput?.getAttribute("value") || ruleName
      };
    });

    console.log(`Found ${rules.length} rules.`, rules);
    return rules;
  }

  // ============================================================
  // Hidden iframe submit
  // ============================================================

  async function fetchRuleDetail(rule) {
    const originalForm =
      document.querySelector("#pageForm") || document.querySelector("form");

    if (!originalForm) {
      throw new Error("Could not find Alma form.");
    }

    if (!rule.submitName) {
      throw new Error(`Rule ${rule.index} has no submit name.`);
    }

    const iframeName = `alma_rule_iframe_${Date.now()}_${rule.index}`;

    const iframe = document.createElement("iframe");
    iframe.name = iframeName;
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = new URL(
        originalForm.getAttribute("action") || "/ful/action/pageAction.do",
        location.origin
      ).href;
    form.target = iframeName;
    form.enctype = originalForm.enctype || "multipart/form-data";
    form.style.display = "none";

    const fd = new FormData(originalForm);

    for (const [name, value] of fd.entries()) {
      if (value instanceof File) continue;

      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }

    const submitInput = document.createElement("input");
    submitInput.type = "hidden";
    submitInput.name = rule.submitName;
    submitInput.value = rule.submitValue || rule.ruleName || "Submit";
    form.appendChild(submitInput);

    document.body.appendChild(form);

    console.log(`Submitting rule ${rule.index + 1}: ${rule.ruleName}`);
    console.log("Iframe form action:", form.action);

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out loading rule ${rule.index + 1}`));
      }, getConfig().iframeTimeoutMs);

      function cleanup() {
        clearTimeout(timeout);
        form.remove();
        iframe.remove();
      }

      iframe.addEventListener("load", () => {
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          const html = pageHtml(doc);
          const responseUrl = iframe.contentWindow.location.href;

          cleanup();

          resolve({
            responseUrl,
            html,
            doc
          });
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      form.submit();
    });

    return result;
  }

  // ============================================================
  // Detail parsing
  // ============================================================

  function extractSelectedRuleId(text, fallbackUrl = "") {
    const patterns = [
      /pageBean\.selectedRuleId[=:"'\s]+(\d+)/i,
      /pageBean\.selectedRuleId%3D(\d+)/i,
      /selectedRuleId[=:"'\s]+(\d+)/i,
      /selectedRuleId%3D(\d+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern) || fallbackUrl.match(pattern);
      if (match?.[1]) return match[1];
    }

    return "";
  }

  function extractTouId(text, fallbackUrl = "") {
    const patterns = [
      /pageBean\.touId[=:"'\s]+(\d+)/i,
      /pageBean\.touId%3D(\d+)/i,
      /touId[=:"'\s]+(\d+)/i,
      /touId%3D(\d+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern) || fallbackUrl.match(pattern);
      if (match?.[1]) return match[1];
    }

    return "";
  }

  function extractRuleDetail(rule, doc, html, responseUrl) {
    const ruleName =
      cleanText(doc.querySelector("#pageBeanrulename")?.textContent) ||
      rule.ruleName;

    const description =
      cleanText(doc.querySelector("#pageBeanruledescription")?.textContent);

    const outputParameter =
      cleanText(doc.querySelector("#pageBeanoutputParameter")?.textContent) ||
      rule.output ||
      "";

    const inputParameters = tableToObjects(
      doc.querySelector("#TABLE_DATA_ruleParamsList")
    );

    const selectedRuleId = extractSelectedRuleId(html, responseUrl);
    const touId = extractTouId(html, responseUrl);

    const isRuleEditor =
      !!doc.querySelector("#TABLE_DATA_ruleParamsList") ||
      !!doc.querySelector("#pageBeanrulename") ||
      !!doc.querySelector("#pageBeanoutputParameter");

    return {
      scrapedAt: nowIso(),
      sourceRuleIndex: rule.index,
      selectedRuleId,
      ruleName,
      description,
      outputParameter,
      touId,
      responseUrl,
      isRuleEditor,
      inputParameters
    };
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

  // ============================================================
  // Main harvest
  // ============================================================

  async function harvestRules(configOverrides = {}) {
    clearState();

    const state = getState();
    state.startedAt = nowIso();
    state.sourceUrl = location.href;
    state.config = {
      ...DEFAULT_CONFIG,
      ...configOverrides
    };
    saveState(state);

    await waitForSelector("#TABLE_DATA_rules");

    const rules = scrapeRulesTable();

    state.rules = rules;
    saveState(state);

    const details = [];
    const output = [];

    for (const rule of rules) {
      try {
        const { responseUrl, html, doc } = await fetchRuleDetail(rule);

        const detail = extractRuleDetail(rule, doc, html, responseUrl);

        if (!detail.isRuleEditor) {
          addWarning("Returned page did not look like rule editor page.", {
            ruleIndex: rule.index,
            ruleName: rule.ruleName,
            responseUrl,
            title: doc.title,
            bodyPreview: cleanText(doc.body?.textContent).slice(0, 500)
          });
        }

        details.push(detail);
        output.push(...flattenRuleDetail(detail));

        const current = getState();
        current.ruleDetails = details;
        current.output = output;
        saveState(current);

        console.log(`Harvested ${rule.index + 1}/${rules.length}`, detail);

        await sleep(getConfig().delayMs);

      } catch (err) {
        const error = {
          ruleIndex: rule.index,
          ruleName: rule.ruleName,
          message: String(err),
          at: nowIso()
        };

        addError("Failed to harvest rule", error);

        output.push({
          sourceRuleIndex: rule.index,
          ruleName: rule.ruleName,
          error: String(err)
        });
      }
    }

    const finalState = getState();
    finalState.ruleDetails = details;
    finalState.output = output;
    finalState.completedAt = nowIso();
    saveState(finalState);

    console.log("Harvest complete.", finalState);

    if (getConfig().downloadOnComplete) {
      downloadOutputs();
    }

    return finalState;
  }

  // ============================================================
  // Downloads
  // ============================================================

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");

    a.href = URL.createObjectURL(blob);
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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

  function downloadJson(data, filename) {
    downloadBlob(
      JSON.stringify(data, null, 2),
      filename,
      "application/json"
    );
  }

  function downloadCsv(rows, filename) {
    downloadBlob(
      toCsv(rows),
      filename,
      "text/csv"
    );
  }

  function downloadOutputs() {
    const state = getState();

    downloadJson(state, "alma-rule-harvest.json");
    downloadCsv(state.output || [], "alma-rule-harvest.csv");
  }

  // ============================================================
  // Status
  // ============================================================

  function status() {
    const state = getState();
    console.log("AlmaFulfillmentNavigator status:", state);
    return state;
  }

  // ============================================================
  // Public API
  // ============================================================

  window.AlmaFulfillmentNavigator = {
    DEFAULT_CONFIG,

    getConfig,
    setConfig,

    getState,
    status,

    clearState,

    harvestRules,

    scrapeRulesTable,

    downloadOutputs,

    urls: {
      makeNgPageUrl,
      getWizardId,
      getStepName,
      getRulesPageUrl
    },

    dom: {
      tableToObjects
    }
  };

  console.log(`
AlmaFulfillmentNavigator loaded.

START ON THE RULES PAGE.

Run:

  await AlmaFulfillmentNavigator.harvestRules()

Optional:

  await AlmaFulfillmentNavigator.harvestRules({
    delayMs: 500,
    iframeTimeoutMs: 45000,
    downloadOnComplete: true
  })

Debug URL builder:

  AlmaFulfillmentNavigator.urls.getWizardId()
  AlmaFulfillmentNavigator.urls.getRulesPageUrl()

Useful commands:

  AlmaFulfillmentNavigator.status()
  AlmaFulfillmentNavigator.downloadOutputs()
  AlmaFulfillmentNavigator.clearState()
`);

})();