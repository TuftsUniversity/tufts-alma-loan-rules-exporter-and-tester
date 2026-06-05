function setStatus(text) {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = text;
  } else {
    console.log(text);
  }
}

function bindClick(id, handler) {
  const el = document.getElementById(id);

  if (!el) {
    console.warn(`Missing popup element: #${id}`);
    return;
  }

  el.addEventListener("click", event => {
    event.preventDefault();

    Promise.resolve(handler()).catch(err => {
      setStatus("Error: " + (err?.message || String(err)));
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  return tab;
}

async function sendCommand(command, payload = {}) {
  const tab = await getActiveTab();

  chrome.tabs.sendMessage(
    tab.id,
    {
      target: "alma-rule-harvester",
      command,
      payload
    },
    response => {
      if (chrome.runtime.lastError) {
        setStatus(
          "Error: " +
          chrome.runtime.lastError.message +
          "\n\nReload the Alma tab. If that does not work, confirm content.js is named correctly and injected by the manifest."
        );
        return;
      }

      if (!response) {
        setStatus("No response from content script.");
        return;
      }

      setStatus(JSON.stringify(response, null, 2));
    }
  );
}

async function readFile(id) {
  const input = document.getElementById(id);
  const file = input?.files?.[0];

  if (!file) {
    throw new Error(`Missing file: ${id}`);
  }

  return {
    filename: file.name,
    text: await file.text()
  };
}

async function generateTestMatrix() {
  const rules = await readFile("rulesFile");
  const itemLocations = await readFile("itemLocationsFile");
  const userGroups = await readFile("userGroupsFile");

  await sendCommand("generateTestMatrix", {
    rulesFilename: rules.filename,
    rulesText: rules.text,
    itemLocationsText: itemLocations.text,
    userGroupsText: userGroups.text
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindClick("startCurrent", () => sendCommand("startCurrentUnit"));
  bindClick("startAll", () => sendCommand("startAllFulfillmentUnits"));

  /*
   * Backward compatibility if popup.html still has a single Start button.
   */
  bindClick("start", () => sendCommand("start"));

  bindClick("resume", () => sendCommand("resume"));
  bindClick("stop", () => sendCommand("stop"));
  bindClick("download", () => sendCommand("download"));
  bindClick("clear", () => sendCommand("clear"));
  bindClick("generateTest", generateTestMatrix);

  setStatus("Popup loaded. Open an Alma page, then choose an action.");
});