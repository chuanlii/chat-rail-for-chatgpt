/** 只做一件事：把快捷键转成给当前标签页内容脚本的 toggle 消息。 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-rail') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    /* 当前标签页不是 ChatGPT，忽略 */
  }
});
