import { PANEL_PORT, type PanelPush, type PanelRequest, type PanelResponse, type PanelTask } from '../shared/messages';

export function request<T>(message: PanelRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: PanelResponse<T> | undefined) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message ?? 'The extension service worker is unavailable.'));
        return;
      }
      if (!response) {
        reject(new Error('No response from the extension service worker.'));
        return;
      }
      if (response.ok) resolve(response.data);
      else reject(new Error(response.error));
    });
  });
}

/**
 * Downloads and clipboard writes need a real document, which a service worker
 * does not have — the panel performs them on the background's behalf.
 */
async function performTask(task: PanelTask): Promise<unknown> {
  if (task.kind === 'download') {
    const url = URL.createObjectURL(new Blob([task.content], { type: task.mimeType }));
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename: task.filename,
        saveAs: false,
      });
      return { downloadId };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  try {
    await navigator.clipboard.writeText(task.text);
    return { copied: true };
  } catch {
    // Clipboard API needs focus; fall back to the legacy path.
    const textarea = document.createElement('textarea');
    textarea.value = task.text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('Clipboard write was blocked by the browser.');
    return { copied: true };
  }
}

export function connect(onPush: (message: PanelPush) => void): () => void {
  const port = chrome.runtime.connect({ name: PANEL_PORT });
  port.onMessage.addListener((message: PanelPush) => {
    if (message.type === 'PANEL_TASK') {
      void performTask(message.task)
        .then((value) => request({ type: 'PANEL_TASK_RESULT', taskId: message.taskId, ok: true, value }))
        .catch((error: unknown) =>
          request({
            type: 'PANEL_TASK_RESULT',
            taskId: message.taskId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }
    onPush(message);
  });
  return () => port.disconnect();
}
