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