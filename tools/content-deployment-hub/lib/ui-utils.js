/**
 * @param {string} text
 */
export async function copyTextToClipboard(text) {
  if (!text) throw new Error('Nothing to copy');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Clipboard is not available in this browser');
}

/**
 * @param {HTMLButtonElement} btn
 * @param {string} successLabel
 * @param {string} errorLabel
 * @param {string} defaultLabel
 * @param {() => Promise<void>} action
 */
export async function runButtonAction(btn, successLabel, errorLabel, defaultLabel, action) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await action();
    btn.textContent = successLabel;
  } catch {
    btn.textContent = errorLabel;
  }
  setTimeout(() => {
    btn.textContent = defaultLabel;
    btn.disabled = false;
  }, 2200);
}

/**
 * Open URLs in new tabs. In embedded DA contexts window.open often returns null
 * even when tabs open — only treat explicit closed windows as blocked.
 * @param {string[]} urls
 * @returns {{ blocked: boolean, opened: number, attempted: number }}
 */
export function openUrlsInNewTabsQuiet(urls) {
  if (urls.length === 0) return { blocked: false, opened: 0, attempted: 0 };
  let opened = 0;
  let explicitlyBlocked = 0;
  urls.forEach((url) => {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (win === null) {
      // Embedded iframe: null does not reliably mean blocked — assume success.
      opened += 1;
      return;
    }
    try {
      if (win.closed) explicitlyBlocked += 1;
      else opened += 1;
    } catch {
      opened += 1;
    }
  });
  const blocked = explicitlyBlocked > 0 && opened === 0;
  return { blocked, opened, attempted: urls.length };
}

/**
 * @param {{ blocked: boolean, opened: number, attempted: number }} result
 */
export function shouldWarnPopupBlock(result) {
  return result.blocked && result.attempted > 0;
}
