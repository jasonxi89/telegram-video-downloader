// Inject MAIN world scripts when Telegram Web pages load
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  if (!tab.url.startsWith("https://web.telegram.org/")) return;

  const isWebA = tab.url.includes("/a");
  const isWebK = tab.url.includes("/k");
  if (!isWebA && !isWebK) return;

  const files = ["downloader.js"];
  if (isWebA) files.push("inject_a.js");
  if (isWebK) files.push("inject_k.js");

  chrome.scripting.executeScript({
    target: { tabId },
    files,
    world: "MAIN",
  });
});
