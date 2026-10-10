import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { AuthError } from './auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'auth.html');
const pageUrl = pathToFileURL(page).href;
const channel = 'journal:auth';
const activeWindows = new Map();
let registeredIpc;

export function isAuthSender(event, window, expectedUrl = pageUrl) {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === expectedUrl,
  );
}

function errorResult(error) {
  return error instanceof AuthError
    ? {
        ok: false,
        error: error.message,
        code: error.code,
        retryAfterMs: error.retryAfterMs,
      }
    : { ok: false, error: '操作未完成，请关闭后重试。', code: 'AUTH_FAILED' };
}

/** Resolves true after a successful unlock/save; resolves false on cancel/close. */
export async function showAuthWindow({ parent, auth, mode }) {
  if (mode !== 'unlock' && mode !== 'settings')
    throw new TypeError('Invalid application lock mode');
  const { BrowserWindow, ipcMain, session } = await import('electron');
  if (!registeredIpc) {
    ipcMain.handle(channel, (event, request) => {
      const entry = activeWindows.get(event.sender.id);
      if (!entry || !isAuthSender(event, entry.window))
        throw new Error('不允许的应用锁请求。');
      return entry.handle(request);
    });
    registeredIpc = ipcMain;
  }

  const isolated = session.fromPartition(
    `journal-auth-${randomBytes(16).toString('hex')}`,
  );
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== pageUrl }),
  );
  const window = new BrowserWindow({
    title: mode === 'unlock' ? '解锁盘口手记' : '应用密码设置',
    width: 560,
    height: mode === 'unlock' ? 560 : 770,
    minWidth: 440,
    minHeight: 500,
    show: false,
    parent,
    modal: Boolean(parent),
    backgroundColor: '#f7f8fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'auth-preload.cjs'),
      session: isolated,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  const contentsId = window.webContents.id;
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  let busy = false;
  let rendererGone = false;
  let complete = false;
  let resolve;
  const result = new Promise((done) => {
    resolve = done;
  });
  const finish = (success) => {
    if (complete) return;
    complete = true;
    activeWindows.delete(contentsId);
    resolve(success);
    if (!window.isDestroyed()) window.destroy();
  };
  window.on('close', (event) => {
    // A credential write already in flight must finish before dismissal.
    if (busy && !complete) event.preventDefault();
  });
  window.on('closed', () => {
    activeWindows.delete(contentsId);
    if (!complete) {
      complete = true;
      resolve(false);
    }
  });
  window.webContents.on('render-process-gone', () => {
    rendererGone = true;
    if (!busy) finish(false);
  });
  window.once('ready-to-show', () => window.show());
  activeWindows.set(window.webContents.id, {
    window,
    async handle(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request))
        return errorResult(new Error());
      if (request.action === 'state')
        return { ok: true, mode, enabled: auth.enabled };
      if (busy)
        return { ok: false, error: '正在处理，请稍候。', code: 'AUTH_BUSY' };
      if (request.action === 'cancel') {
        finish(false);
        return { ok: true };
      }
      if (
        (mode === 'unlock' && request.action !== 'unlock') ||
        (mode === 'settings' && request.action !== 'save')
      )
        return errorResult(new Error());
      busy = true;
      try {
        if (mode === 'unlock') {
          if (!(await auth.verify(request.password)))
            return {
              ok: false,
              error: '密码不正确，请重试。',
              code: 'INVALID_PASSWORD',
            };
        } else {
          await auth.setPassword(request.currentPassword, request.newPassword);
        }
        finish(true);
        return { ok: true };
      } catch (error) {
        return errorResult(error);
      } finally {
        busy = false;
        if (!complete && rendererGone) finish(false);
      }
    },
  });
  try {
    await window.loadFile(page);
  } catch {
    finish(false);
  }
  return result;
}
