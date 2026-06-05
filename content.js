/*
 * Alma Fulfillment Rule Harvester - Chrome Extension Content Script
 *
 * Supports:
 *   1. Harvest current fulfillment unit from its edit/rules page.
 *   2. Harvest all fulfillment units from TABLE_DATA_fulfillmentUnits.
 *   3. Generate rule-test flat and pivot CSVs from harvested rule output plus
 *      item-policy/location and user-group input CSVs.
 */

(() => {
  if (window.__almaRuleHarvesterLoaded) return;
  window.__almaRuleHarvesterLoaded = true;

  const STORAGE_KEY = "almaRuleHarvesterStateV2";

  const CONFIG = {
    delayMs: 900,
    maxWaitMs: 30000,
    autoDownloadOnComplete: true,
    watchdogIntervalMs: 2000
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

  function sanitizeFilename(value) {
    return String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function initialState() {
    return {
      version: 2,
      active: false,
      mode: "singleUnit",
      phase: "idle",
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      lastUrl: "",

      fulfillmentUnits: [],
      currentFulfillmentUnitIndex: 0,
      currentFulfillmentUnitName: "",
      currentFulfillmentUnitCode: "",

      currentRuleIndex: 0,
      rules: [],
      ruleDetails: [],
      output: [],

      locations: [],
      locationsString: "",

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
      .filter(row => Object.values(row).some(value => cleanText(value) !== ""));
  }

  function getFulfillmentUnitNameFromPage() {
    return cleanText(
      document.querySelector(
        "#SPAN_FORM_ID_SECTION_fulfillment\\.unit_edit\\.fulfillmentUnit_FORM_Fulfillment_Unit_INPUT_pageBeaneditedFulfillmentUnitname"
      )?.getAttribute("title") ||
      document.querySelector(
        "#SPAN_FORM_ID_SECTION_fulfillment\\.unit_edit\\.fulfillmentUnit_FORM_Fulfillment_Unit_INPUT_pageBeaneditedFulfillmentUnitname"
      )?.textContent
    );
  }

  function isFulfillmentUnitsListPage() {
    return !!document.querySelector("#TABLE_DATA_fulfillmentUnits");
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

  function isTouPage() {
    return !!document.querySelector("#TABLE_DATA_policiesList");
  }

  function isLocationsPage() {
    return !!document.querySelector("#TABLE_DATA_fulfillmentUnitLocationsList");
  }

  // ============================================================
  // Fulfillment unit list
  // ============================================================

  function scrapeFulfillmentUnitsTable() {
    const table = document.querySelector("#TABLE_DATA_fulfillmentUnits");

    if (!table) {
      throw new Error("Fulfillment units table #TABLE_DATA_fulfillmentUnits not found.");
    }

    const rows = [...table.querySelectorAll("tbody tr")];

    const units = rows.map((row, index) => {
      const codeInput =
        row.querySelector(`#INPUT_SELENIUM_ID_fulfillmentUnits_ROW_${index}_COL_fucode`);

      const code =
        cleanText(codeInput?.value || codeInput?.getAttribute("title")) ||
        cleanText(
          row.querySelector(`#SELENIUM_ID_fulfillmentUnits_ROW_${index}_COL_fucode`)?.textContent
        );

      const nameSpan =
        row.querySelector(`#SPAN_SELENIUM_ID_fulfillmentUnits_ROW_${index}_COL_funame`);

      const name =
        cleanText(nameSpan?.getAttribute("title") || nameSpan?.textContent) ||
        code;

      const ownerSpan =
        row.querySelector(`#SPAN_SELENIUM_ID_fulfillmentUnits_ROW_${index}_COL_definitionLevel`);

      return {
        fulfillmentUnitIndex: index,
        code,
        name,
        owner: cleanText(ownerSpan?.getAttribute("title") || ownerSpan?.textContent),
        submitSelector: codeInput?.id ? `#${cssEscape(codeInput.id)}` : "",
        submitName: codeInput?.getAttribute("name") || "",
        submitValue: codeInput?.value || code
      };
    }).filter(unit => unit.submitSelector && (unit.name || unit.code));

    console.log(`[AlmaRuleHarvester] Found ${units.length} fulfillment units.`, units);
    return units;
  }

  function clickFulfillmentUnitByIndex(index) {
    const input = document.querySelector(
      `#INPUT_SELENIUM_ID_fulfillmentUnits_ROW_${index}_COL_fucode`
    );

    if (!input) {
      throw new Error(`Could not find fulfillment unit submit input for row ${index}.`);
    }

    console.log("[AlmaRuleHarvester] Clicking fulfillment unit:", {
      index,
      id: input.id,
      value: input.value,
      title: input.getAttribute("title")
    });

    input.click();
  }

  // ============================================================
  // Unit tabs
  // ============================================================

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

    console.log("[AlmaRuleHarvester] Clicking Rules tab.", tab);

    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    tab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function scrapeLocationsList() {
    const table = document.querySelector("#TABLE_DATA_fulfillmentUnitLocationsList");

    if (!table) {
      throw new Error("Could not find fulfillment unit locations table.");
    }

    /*
     * Only the Location Name column.
     */
    const locationCells = [
      ...table.querySelectorAll('td[id*="_COL_locationlocationName"]')
    ];

    const locations = locationCells
      .map(td => {
        const span = td.querySelector("span");
        return cleanText(span?.getAttribute("title") || span?.textContent);
      })
      .filter(Boolean);

    const uniqueLocations = unique(locations);
    const locationsString = uniqueLocations.join("; ");

    const state = getState();

    state.locations = uniqueLocations;
    state.locationsString = locationsString;

    if (state.fulfillmentUnits?.[state.currentFulfillmentUnitIndex]) {
      state.fulfillmentUnits[state.currentFulfillmentUnitIndex].locations = uniqueLocations;
      state.fulfillmentUnits[state.currentFulfillmentUnitIndex].locationsString = locationsString;
    }

    saveState(state);

    console.log("[AlmaRuleHarvester] Locations scraped:", uniqueLocations);
    return uniqueLocations;
  }

  // ============================================================
  // Rule list/detail
  // ============================================================

  function scrapeRulesTable() {
    const table = document.querySelector("#TABLE_DATA_rules");

    if (!table) {
      throw new Error("Rules table #TABLE_DATA_rules not found.");
    }

    const rows = [...table.querySelectorAll("tbody tr")];
    const visibleRows = tableToObjects(table);

    const state = getState();
    const fu = currentFulfillmentUnitFromState(state);

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
        fulfillmentUnitIndex: fu.fulfillmentUnitIndex,
        fulfillmentUnitName: fu.fulfillmentUnitName,
        fulfillmentUnitCode: fu.fulfillmentUnitCode,
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

    console.log("[AlmaRuleHarvester] Clicking rule input", {
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

  function currentFulfillmentUnitFromState(state = getState()) {
    const unit = state.fulfillmentUnits?.[state.currentFulfillmentUnitIndex] || {};

    return {
      fulfillmentUnitIndex:
        Number.isFinite(Number(unit.fulfillmentUnitIndex))
          ? Number(unit.fulfillmentUnitIndex)
          : Number(state.currentFulfillmentUnitIndex || 0),
      fulfillmentUnitName:
        state.currentFulfillmentUnitName ||
        unit.name ||
        getFulfillmentUnitNameFromPage() ||
        "Current Fulfillment Unit",
      fulfillmentUnitCode:
        state.currentFulfillmentUnitCode ||
        unit.code ||
        "",
      locations:
        state.locations || unit.locations || [],
      locationsString:
        state.locationsString || unit.locationsString || ""
    };
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
    const fu = currentFulfillmentUnitFromState(state);
    const locationsString = fu.locationsString || "";

    if (!detail.inputParameters?.length) {
      return [{
        fulfillmentUnitIndex: fu.fulfillmentUnitIndex,
        fulfillmentUnitName: fu.fulfillmentUnitName,
        fulfillmentUnitCode: fu.fulfillmentUnitCode,
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
      fulfillmentUnitIndex: fu.fulfillmentUnitIndex,
      fulfillmentUnitName: fu.fulfillmentUnitName,
      fulfillmentUnitCode: fu.fulfillmentUnitCode,
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
    const state = getState();
    const fu = currentFulfillmentUnitFromState(state);
    const inputParameters =
      tableToObjects(document.querySelector("#TABLE_DATA_ruleParamsList"));

    const detail = {
      scrapedAt: nowIso(),
      fulfillmentUnitIndex: fu.fulfillmentUnitIndex,
      fulfillmentUnitName: fu.fulfillmentUnitName,
      fulfillmentUnitCode: fu.fulfillmentUnitCode,
      sourceRuleIndex: state.currentRuleIndex,
      selectedRuleId: extractSelectedRuleIdFromCurrentPage(),
      ruleName: getRuleName(),
      description: getRuleDescription(),
      outputParameter: getOutputParameter(),
      touId: extractTouIdFromCurrentPage(),
      ruleUrl: location.href,
      inputParameters
    };

    const rows = flattenRuleDetail(detail);
    const key = detailKey(detail);

    state.ruleDetails = [
      ...(state.ruleDetails || []).filter(d => detailKey(d) !== key),
      detail
    ].sort(ruleSort);

    state.output = [
      ...(state.output || []).filter(r => rowRuleKey(r) !== key),
      ...rows
    ].sort(rowSort);

    saveState(state);

    console.log("[AlmaRuleHarvester] Scraped rule detail:", detail);
    return detail;
  }

  function detailKey(d) {
    return `${d.fulfillmentUnitIndex ?? ""}|${d.sourceRuleIndex ?? ""}`;
  }

  function rowRuleKey(r) {
    return `${r.fulfillmentUnitIndex ?? ""}|${r.sourceRuleIndex ?? ""}`;
  }

  function ruleSort(a, b) {
    return (
      Number(a.fulfillmentUnitIndex) - Number(b.fulfillmentUnitIndex) ||
      Number(a.sourceRuleIndex) - Number(b.sourceRuleIndex)
    );
  }

  function rowSort(a, b) {
    return (
      Number(a.fulfillmentUnitIndex) - Number(b.fulfillmentUnitIndex) ||
      Number(a.sourceRuleIndex) - Number(b.sourceRuleIndex)
    );
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
    const currentKey = `${state.currentFulfillmentUnitIndex}|${state.currentRuleIndex}`;

    state.ruleDetails = (state.ruleDetails || []).map(detail => {
      if (detailKey(detail) !== currentKey) return detail;

      return {
        ...detail,
        touPolicies: rows,
        touPolicyColumns: policyColumns
      };
    });

    state.output = (state.output || []).map(row => {
      if (rowRuleKey(row) !== currentKey) return row;

      return {
        ...row,
        ...policyColumns
      };
    });

    saveState(state);

    console.log("[AlmaRuleHarvester] Scraped TOU policies:", policyColumns);
    return policyColumns;
  }

  function clickBackButton(label = "Back") {
    const backButton =
      document.querySelector("#PAGE_BUTTONS_cbuttonnavigationback") ||
      document.querySelector("button[name='page.buttons.operation'][value='Back']") ||
      document.querySelector("button[value='Back']") ||
      document.querySelector("#generic_back_button");

    if (!backButton) {
      throw new Error(`Could not find Alma ${label} button.`);
    }

    console.log(`[AlmaRuleHarvester] Clicking ${label} button:`, {
      id: backButton.id,
      name: backButton.name,
      value: backButton.value,
      onclick: backButton.getAttribute("onclick")
    });

    backButton.click();
  }

  // ============================================================
  // Downloads
  // ============================================================

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

  function downloadOutputs() {
    const state = getState();

    const name =
      state.mode === "allUnits"
        ? "all_fulfillment_units"
        : sanitizeFilename(
            getFulfillmentUnitNameFromPage() ||
            state.currentFulfillmentUnitName ||
            "alma_fulfillment_unit"
          );

    const baseFilename = `alma_rule_harvest_${name}`;

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

  // ============================================================
  // Start / stop
  // ============================================================

  async function startCurrentUnit() {
    clearState();

    const state = initialState();
    state.active = true;
    state.mode = "singleUnit";
    state.phase = "openingLocations";
    state.startedAt = nowIso();
    state.currentFulfillmentUnitIndex = 0;
    state.currentFulfillmentUnitName = getFulfillmentUnitNameFromPage() || "Current Fulfillment Unit";
    state.currentFulfillmentUnitCode = "";
    state.rules = [];
    state.locations = [];
    state.locationsString = "";
    state.fulfillmentUnits = [{
      fulfillmentUnitIndex: 0,
      name: state.currentFulfillmentUnitName,
      code: ""
    }];

    saveState(state);

    await sleep(CONFIG.delayMs);
    clickLocationsTab();
    console.log("[AlmaRuleHarvester] Started current unit harvest.");
  }

  async function startAllFulfillmentUnits() {
    clearState();

    await waitForSelector("#TABLE_DATA_fulfillmentUnits");

    const units = scrapeFulfillmentUnitsTable();

    if (!units.length) {
      throw new Error("No fulfillment units found.");
    }

    const state = initialState();
    state.active = true;
    state.mode = "allUnits";
    state.phase = "openingFulfillmentUnit";
    state.startedAt = nowIso();
    state.fulfillmentUnits = units;
    state.currentFulfillmentUnitIndex = 0;
    state.currentFulfillmentUnitName = units[0].name;
    state.currentFulfillmentUnitCode = units[0].code;
    state.rules = [];
    state.locations = [];
    state.locationsString = "";

    saveState(state);

    await sleep(CONFIG.delayMs);
    clickFulfillmentUnitByIndex(0);
    console.log("[AlmaRuleHarvester] Started all fulfillment units harvest.");
  }

  /*
   * Backward compatibility: Start button now harvests the current unit.
   */
  async function start() {
    if (isFulfillmentUnitsListPage()) {
      await startAllFulfillmentUnits();
    } else {
      await startCurrentUnit();
    }
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

  // ============================================================
  // Workflow
  // ============================================================

  async function continueWorkflow() {
    let state = getState();

    console.log("[AlmaRuleHarvester] Continue workflow:", {
      mode: state.mode,
      phase: state.phase,
      currentFulfillmentUnitIndex: state.currentFulfillmentUnitIndex,
      currentRuleIndex: state.currentRuleIndex,
      isFulfillmentUnitsListPage: isFulfillmentUnitsListPage(),
      isLocationsPage: isLocationsPage(),
      isRulesListPage: isRulesListPage(),
      isRuleEditorPage: isRuleEditorPage(),
      isTouPage: isTouPage(),
      url: location.href
    });

    if (!state.active) return;

    if (state.phase === "openingFulfillmentUnit") {
      await waitForEither([
        "#A_NAV_LINK_fulfillmentunit_editfulfillmentUnitLocations_span",
        "#A_NAV_LINK_fulfillmentunit_editfulfillmentUnitRules_span"
      ]);

      const pageName = getFulfillmentUnitNameFromPage();
      state = getState();
      if (pageName) {
        state.currentFulfillmentUnitName = pageName;
        if (state.fulfillmentUnits?.[state.currentFulfillmentUnitIndex]) {
          state.fulfillmentUnits[state.currentFulfillmentUnitIndex].name = pageName;
        }
        saveState(state);
      }

      state = getState();
      state.phase = "openingLocations";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickLocationsTab();
      return;
    }

    if (state.phase === "openingLocations") {
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
      state.currentRuleIndex = 0;

      if (!rules.length) {
        console.warn("[AlmaRuleHarvester] No rules for current fulfillment unit.");
        await finishCurrentFulfillmentUnit(state);
        return;
      }

      state.phase = "clickingRule";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickRuleByIndex(0);
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
      clickBackButton("Back from TOU to rule");
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
      clickBackButton("Back from rule to rules");
      return;
    }

    if (state.phase === "returningToRules") {
      await waitForSelector("#TABLE_DATA_rules");

      state = getState();
      const nextIndex = Number(state.currentRuleIndex || 0) + 1;
      state.currentRuleIndex = nextIndex;

      if (nextIndex >= state.rules.length) {
        await finishCurrentFulfillmentUnit(state);
        return;
      }

      state.phase = "clickingRule";
      saveState(state);

      await sleep(CONFIG.delayMs);
      clickRuleByIndex(nextIndex);
      return;
    }

    if (state.phase === "returningToFulfillmentUnits") {
      await waitForSelector("#TABLE_DATA_fulfillmentUnits");

      state = getState();
      const nextUnitIndex = Number(state.currentFulfillmentUnitIndex || 0) + 1;

      if (nextUnitIndex >= state.fulfillmentUnits.length) {
        state.phase = "complete";
        state.active = false;
        state.completedAt = nowIso();
        saveState(state);

        console.log("[AlmaRuleHarvester] All fulfillment units complete.", state);

        if (CONFIG.autoDownloadOnComplete) downloadOutputs();
        return;
      }

      const nextUnit = state.fulfillmentUnits[nextUnitIndex];

      state.phase = "openingFulfillmentUnit";
      state.currentFulfillmentUnitIndex = nextUnitIndex;
      state.currentFulfillmentUnitName = nextUnit.name;
      state.currentFulfillmentUnitCode = nextUnit.code;
      state.currentRuleIndex = 0;
      state.rules = [];
      state.locations = [];
      state.locationsString = "";

      saveState(state);

      await sleep(CONFIG.delayMs);
      clickFulfillmentUnitByIndex(nextUnitIndex);
      return;
    }

    console.log("[AlmaRuleHarvester] No matching continuation branch.");
  }

  async function finishCurrentFulfillmentUnit(state) {
    if (state.mode === "allUnits") {
      state.phase = "returningToFulfillmentUnits";
      saveState(state);
      await sleep(CONFIG.delayMs);
      clickBackButton("Back from fulfillment unit to fulfillment units list");
      return;
    }

    state.phase = "complete";
    state.active = false;
    state.completedAt = nowIso();
    saveState(state);

    console.log("[AlmaRuleHarvester] Current fulfillment unit complete.", state);

    if (CONFIG.autoDownloadOnComplete) downloadOutputs();
  }

  // ============================================================
  // Test matrix generator
  // ============================================================

  function parseDelimited(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (ch === '"' && inQuotes && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        row.push(cell);
        cell = "";
      } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
        if (ch === "\r" && next === "\n") i++;
        row.push(cell);
        if (row.some(v => cleanText(v) !== "")) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }

    row.push(cell);
    if (row.some(v => cleanText(v) !== "")) rows.push(row);

    if (!rows.length) return [];

    const headers = rows[0].map(h => cleanText(h));
    return rows.slice(1).map(values => {
      const obj = {};
      headers.forEach((h, i) => obj[h || `Column ${i + 1}`] = cleanText(values[i]));
      return obj;
    });
  }

  function getField(row, aliases) {
    const entries = Object.entries(row || {});
    for (const alias of aliases) {
      const found = entries.find(([key]) =>
        cleanHeader(key) === cleanHeader(alias)
      );
      if (found) return cleanText(found[1]);
    }
    return "";
  }

  function cleanHeader(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function parseRuleInput(text, filename = "") {
    const trimmed = String(text || "").trim();

    if (!trimmed) {
      throw new Error("Loan rule input is empty.");
    }

    if (filename.toLowerCase().endsWith(".json") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.output)) return parsed.output;
      if (Array.isArray(parsed.ruleDetails)) {
        return parsed.ruleDetails.flatMap(detail => {
          const base = {
            fulfillmentUnitIndex: detail.fulfillmentUnitIndex,
            fulfillmentUnitName: detail.fulfillmentUnitName,
            fulfillmentUnitCode: detail.fulfillmentUnitCode,
            sourceRuleIndex: detail.sourceRuleIndex,
            locations: detail.locations,
            selectedRuleId: detail.selectedRuleId,
            ruleName: detail.ruleName,
            outputParameter: detail.outputParameter,
            touId: detail.touId
          };
          const params = detail.inputParameters || [];
          if (!params.length) return [{ ...base, parameterName: "", operator: "", value: "" }];
          return params.map(param => ({
            ...base,
            parameterName: param.Name || param.Parameter || param["Column 2"] || "",
            operator: param.Operator || param["Column 3"] || "",
            value: param.Value || param["Column 4"] || ""
          }));
        });
      }
    }

    return parseDelimited(trimmed);
  }

  function normalizeScenarioRows(itemLocationRows, userGroupRows) {
    const itemLocationPairs = itemLocationRows.map(row => ({
      location: getField(row, ["location", "location name", "locationName"]),
      itemPolicy: getField(row, ["item policy", "itemPolicy", "item policy name", "policy"])
    })).filter(row => row.location || row.itemPolicy);

    const userGroups = userGroupRows.map(row =>
      getField(row, ["user group", "userGroup", "group", "patron group", "patronGroup"]) ||
      cleanText(Object.values(row)[0] || "")
    ).filter(Boolean);

    const scenarios = [];

    for (const pair of itemLocationPairs) {
      for (const userGroup of userGroups) {
        scenarios.push({
          location: pair.location,
          itemPolicy: pair.itemPolicy,
          userGroup
        });
      }
    }

    return scenarios;
  }

  function splitList(value) {
    return String(value || "")
      .split(/\s*(?:;|\||,|\n)\s*/)
      .map(cleanText)
      .filter(Boolean);
  }

  function normalizeParamName(name) {
    const n = String(name || "").toLowerCase();

    if (n.includes("location")) return "location";
    if (n.includes("item") && n.includes("policy")) return "itemPolicy";
    if (n.includes("user") && n.includes("group")) return "userGroup";

    return "";
  }

  function normalizeOperator(op) {
    const o = String(op || "").toLowerCase().replace(/\s+/g, " ").trim();

    if (o === "=" || o === "equals" || o === "equal" || o === "is") return "=";
    if (o.includes("not") && o.includes("in")) return "not in list";
    if (o.includes("in") && o.includes("list")) return "in list";
    if (o === "in") return "in list";
    if (o === "!=" || o === "<>" || o === "not equals" || o === "is not") return "not in list";

    return "=";
  }

  function normalizeValue(value) {
    return cleanText(value).toLowerCase();
  }

  function conditionMatches(condition, scenario) {
    const key = normalizeParamName(condition.parameterName);
    if (!key) return true;

    const actual = normalizeValue(scenario[key]);
    const values = splitList(condition.value).map(normalizeValue);
    const op = normalizeOperator(condition.operator);

    if (!values.length) return true;

    if (op === "=") {
      return actual === values[0];
    }

    if (op === "in list") {
      return values.includes(actual);
    }

    if (op === "not in list") {
      return !values.includes(actual);
    }

    return actual === values[0];
  }

  function groupRules(ruleRows) {
    const byRule = new Map();

    for (const row of ruleRows) {
      const fulfillmentUnitIndex =
        getField(row, ["fulfillmentUnitIndex", "fulfillment unit index"]) ||
        row.fulfillmentUnitIndex ||
        "0";

      const sourceRuleIndex =
        getField(row, ["sourceRuleIndex", "rule index", "source rule index"]) ||
        row.sourceRuleIndex ||
        "0";

      const key = `${fulfillmentUnitIndex}|${sourceRuleIndex}`;

      if (!byRule.has(key)) {
        byRule.set(key, {
          fulfillmentUnitIndex: Number(fulfillmentUnitIndex),
          fulfillmentUnitName:
            getField(row, ["fulfillmentUnitName", "fulfillment unit name"]) ||
            row.fulfillmentUnitName ||
            "",
          fulfillmentUnitCode:
            getField(row, ["fulfillmentUnitCode", "fulfillment unit code"]) ||
            row.fulfillmentUnitCode ||
            "",
          sourceRuleIndex: Number(sourceRuleIndex),
          ruleName:
            getField(row, ["ruleName", "rule name"]) ||
            row.ruleName ||
            "",
          outputTou:
            getField(row, ["outputParameter", "output tou", "output", "TOU"]) ||
            row.outputParameter ||
            "",
          locations: splitList(
            getField(row, ["locations", "fulfillment unit locations"]) ||
            row.locations ||
            ""
          ),
          conditions: []
        });
      }

      const parameterName =
        getField(row, ["parameterName", "parameter", "Name"]) ||
        row.parameterName ||
        "";

      const operator =
        getField(row, ["operator", "Operator"]) ||
        row.operator ||
        "";

      const value =
        getField(row, ["value", "Value"]) ||
        row.value ||
        "";

      if (cleanText(parameterName)) {
        byRule.get(key).conditions.push({ parameterName, operator, value });
      }
    }

    return [...byRule.values()].sort((a, b) =>
      Number(a.fulfillmentUnitIndex) - Number(b.fulfillmentUnitIndex) ||
      Number(a.sourceRuleIndex) - Number(b.sourceRuleIndex)
    );
  }

  function groupFulfillmentUnitsFromRules(rules) {
    const map = new Map();

    for (const rule of rules) {
      const key = String(rule.fulfillmentUnitIndex);
      if (!map.has(key)) {
        map.set(key, {
          fulfillmentUnitIndex: rule.fulfillmentUnitIndex,
          fulfillmentUnitName: rule.fulfillmentUnitName,
          fulfillmentUnitCode: rule.fulfillmentUnitCode,
          locations: rule.locations || []
        });
      } else {
        const existing = map.get(key);
        existing.locations = unique([...(existing.locations || []), ...(rule.locations || [])]);
      }
    }

    return [...map.values()].sort((a, b) => Number(a.fulfillmentUnitIndex) - Number(b.fulfillmentUnitIndex));
  }

  function fulfillmentUnitContainsLocation(unit, location) {
    const loc = normalizeValue(location);
    return (unit.locations || []).map(normalizeValue).includes(loc);
  }

  function findFirstMatchingRule(rules, scenario) {
    const units = groupFulfillmentUnitsFromRules(rules);
    const candidateUnit = units.find(unit => fulfillmentUnitContainsLocation(unit, scenario.location));

    
    if (!candidateUnit) {
      return {
        noMatchReason: "No fulfillment unit contains this location",
        candidateFulfillmentUnit: null,
        matchedRule: null
      };
    }

    const candidateRules = rules.filter(rule =>
      Number(rule.fulfillmentUnitIndex) === Number(candidateUnit.fulfillmentUnitIndex)
    );

    for (const rule of candidateRules) {
      const matches = rule.conditions.every(condition =>
        conditionMatches(condition, scenario)
      );

      if (matches) {
        return {
          noMatchReason: "",
          candidateFulfillmentUnit: candidateUnit,
          matchedRule: rule
        };
      }
    }

    return {
      noMatchReason: "No rule matched in fulfillment unit",
      candidateFulfillmentUnit: candidateUnit,
      matchedRule: null
    };
  }

  function evaluateLoanRules(ruleRows, itemLocationRows, userGroupRows) {
    const rules = groupRules(ruleRows);
    const scenarios = normalizeScenarioRows(itemLocationRows, userGroupRows);

    console.log("[AlmaRuleHarvester] Evaluating loan rules with scenarios:", {
      rules,
      scenarios
    });
    const results = scenarios.map(scenario => {
      const match = findFirstMatchingRule(rules, scenario);
      const rule = match.matchedRule;
      const unit = match.candidateFulfillmentUnit;

      return {
        location: scenario.location,
        itemPolicy: scenario.itemPolicy,
        userGroup: scenario.userGroup,
        fulfillmentUnitIndex: unit?.fulfillmentUnitIndex ?? "",
        fulfillmentUnitName: unit?.fulfillmentUnitName ?? "",
        fulfillmentUnitCode: unit?.fulfillmentUnitCode ?? "",
        matchedRuleIndex: rule?.sourceRuleIndex ?? "",
        matchedRuleName: rule?.ruleName ?? "",
        outputTou: rule?.outputTou ?? "NO MATCH",
        noMatchReason: match.noMatchReason || ""
      };
    });

    return {
      rules,
      scenarios,
      results,
      pivot: pivotResults(results)
    };
  }

  function pivotResults(results) {
    const pivot = {};

    for (const row of results) {
      const loc = row.location || "";
      const colKey = `${row.itemPolicy || ""} | ${row.userGroup || ""}`;

      if (!pivot[loc]) pivot[loc] = {};
      pivot[loc][colKey] = row.outputTou === "NO MATCH"
        ? `NO MATCH${row.noMatchReason ? ` (${row.noMatchReason})` : ""}`
        : `${row.fulfillmentUnitName} :: ${row.outputTou}`;
    }

    return pivot;
  }

  function pivotToCsv(pivot) {
    const locations = Object.keys(pivot);
    const columns = unique(locations.flatMap(location => Object.keys(pivot[location] || {})));

    const rows = [
      ["Location", ...columns],
      ...locations.map(location => [
        location,
        ...columns.map(col => pivot[location]?.[col] || "")
      ])
    ];

    return rows.map(row => row.map(csvEscape).join(",")).join("\n");
  }

  function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  async function generateTestMatrix(payload = {}) {
    const ruleRows = parseRuleInput(payload.rulesText || "", payload.rulesFilename || "");
    const itemLocationRows = parseDelimited(payload.itemLocationsText || "");
    const userGroupRows = parseDelimited(payload.userGroupsText || "");

    const evaluated = evaluateLoanRules(ruleRows, itemLocationRows, userGroupRows);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    downloadText(
      `alma_loan_rule_test_flat_${stamp}.csv`,
      toCsv(evaluated.results),
      "text/csv"
    );

    downloadText(
      `alma_loan_rule_test_pivot_${stamp}.csv`,
      pivotToCsv(evaluated.pivot),
      "text/csv"
    );

    downloadText(
      `alma_loan_rule_test_${stamp}.json`,
      JSON.stringify(evaluated, null, 2),
      "application/json"
    );

    console.log("[AlmaRuleHarvester] Test matrix generated.", evaluated);
    return evaluated;
  }

  // ============================================================
  // UI / extension messaging
  // ============================================================

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
    panel.style.maxWidth = "320px";

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

    panel.appendChild(mkButton("Start Current", startCurrentUnit));
    panel.appendChild(mkButton("Start All", startAllFulfillmentUnits));
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
    const unitTotal = state.fulfillmentUnits?.length || 0;
    const ruleTotal = state.rules?.length || 0;
    const unitLabel = unitTotal
      ? `FU ${Math.min(Number(state.currentFulfillmentUnitIndex || 0) + 1, unitTotal)}/${unitTotal}`
      : "FU n/a";
    const ruleLabel = ruleTotal
      ? `Rule ${Math.min(Number(state.currentRuleIndex || 0) + 1, ruleTotal)}/${ruleTotal}`
      : "Rule n/a";

    el.textContent = `${state.phase}; ${unitLabel}; ${ruleLabel}`;
  }

  function installCommandListener() {
    if (!chrome?.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.target !== "alma-rule-harvester") return false;

      (async () => {
        try {
          let result = null;

          if (message.command === "start") result = await start();
          if (message.command === "startCurrentUnit") result = await startCurrentUnit();
          if (message.command === "startAllFulfillmentUnits") result = await startAllFulfillmentUnits();
          if (message.command === "resume") result = await resume();
          if (message.command === "stop") result = await stop();
          if (message.command === "download") result = downloadOutputs();
          if (message.command === "clear") result = clearState();
          if (message.command === "generateTestMatrix") result = await generateTestMatrix(message.payload || {});

          sendResponse({ ok: true, state: getState(), result });
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
        state.mode,
        state.phase,
        state.currentFulfillmentUnitIndex,
        state.currentRuleIndex,
        location.href,
        isFulfillmentUnitsListPage(),
        isLocationsPage(),
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
    }, CONFIG.watchdogIntervalMs);
  }

    function normalizeOperator(op) {
  const o = String(op || "").toLowerCase().trim();

  if (o === "=" || o === "equals" || o === "is") return "=";
  if (o.includes("not") && o.includes("in")) return "not in list";
  if (o.includes("in")) return "in list";

  return "=";
}

function conditionMatches(condition, scenario) {
  const key = normalizeParamName(condition.parameterName);
  if (!key) return true;

  const actual = cleanText(scenario[key]).toLowerCase();
  const values = String(condition.value || "")
    .split(/\s*(?:;|,|\|)\s*/)
    .map(v => cleanText(v).toLowerCase())
    .filter(Boolean);

  const op = normalizeOperator(condition.operator);

  if (op === "=") return actual === values[0];
  if (op === "in list") return values.includes(actual);
  if (op === "not in list") return !values.includes(actual);

  return actual === values[0];
}

function normalizeParamName(name) {
  const n = String(name || "").toLowerCase();

  if (n.includes("location")) return "location";
  if (n.includes("item") && n.includes("policy")) return "itemPolicy";
  if (n.includes("user") && n.includes("group")) return "userGroup";

  return "";
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
    startCurrentUnit,
    startAllFulfillmentUnits,
    stop,
    resume,
    status,
    clearState,
    downloadOutputs,
    continueWorkflow,
    tableToObjects,
    generateTestMatrix,
    evaluateLoanRules
  };

  boot().catch(err => addError("Boot failed", { error: String(err) }));

  console.log("[AlmaRuleHarvester] Content script loaded v2.");
})();