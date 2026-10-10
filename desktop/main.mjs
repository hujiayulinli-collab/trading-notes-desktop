import { app, BrowserWindow, dialog, ipcMain, session, Menu } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isAppUrl, allowRequest, validSender } from './security.mjs';
import { createApp } from './service.mjs';
import { AuthStore } from './auth.mjs';
import { showAuthWindow } from './auth-window.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let window,
  service,
  origin,
  quitting = false,
  dialogBusy = false,
  locked = true,
  auth,
  allowClose = false,
  preparingClose = false,
  closeTimer,
  uiLoaded = false;
app.setName('盘口手记');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (locked || quitting) return;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on('window-all-closed', () => {
    if (window) app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (window && !window.isDestroyed() && !allowClose) {
      event.preventDefault();
      window.close();
      return;
    }
    if (!service) return;
    event.preventDefault();
    quitting = true;
    // Give accepted saves/analysis their normal request lifetime; never kill a write midway.
    service.server.close(
      () =>
        void service
          .drain()
          .then(() => service.store.unlock())
          .catch(() => {})
          .finally(() => app.quit()),
    );
    service.server.closeIdleConnections();
  });
  void app
    .whenReady()
    .then(start)
    .catch(async (error) => {
      if (!uiLoaded) allowClose = true;
      await dialog.showMessageBox({
        type: 'error',
        title: '盘口手记无法启动',
        message: error.message,
        detail: '没有删除或覆盖你的资料。检查文件夹权限及磁盘空间后重试。',
      });
      app.quit();
    });
}
async function start() {
  const settingsRoot = app.getPath('userData');
  await fs.mkdir(settingsRoot, { recursive: true });
  auth = await new AuthStore(settingsRoot).init();
  if (auth.enabled && !(await showAuthWindow({ auth, mode: 'unlock' })))
    return app.quit();
  locked = false;
  const settingsFile = path.join(settingsRoot, '.local-settings.json');
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(
        '本机保存位置配置损坏。请保留配置并联系维护者，不会自动新建空资料库。',
      );
  }
  if (!settings) {
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: '欢迎使用盘口手记',
      message: '选择真正保存在你电脑上的资料文件夹',
      detail:
        '可选空文件夹，或已有包含 journal.json 的资料库。交易和截图不写入浏览器、不上传站点所有者。周报也保存在此文件夹。云盘同步文件夹可能被其服务自动上传。GPT 功能需你主动发起。',
      buttons: ['选择文件夹', '退出'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return app.quit();
    const result = await dialog.showOpenDialog({
      title: '选择盘口手记资料文件夹',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (result.canceled || !result.filePaths[0]) return app.quit();
    const directory = path.resolve(result.filePaths[0]);
    const entries = await fs.readdir(directory);
    if (entries.length && !entries.includes('journal.json'))
      throw new Error(
        '请选择空文件夹或包含 journal.json 的现有资料库。原文件夹未改动。',
      );
    settings = { directory };
  }
  if (
    typeof settings.directory !== 'string' ||
    !path.isAbsolute(settings.directory)
  )
    throw new Error('资料库保存位置无效。');
  // Missing/removable storage must never silently turn into a new empty journal.
  await fs.access(settings.directory);
  const token = randomBytes(32).toString('hex');
  service = await createApp({
    root: app.getAppPath(),
    settingsRoot,
    directory: settings.directory,
    sessionToken: token,
    isLocked: () => locked,
    reportsRoot: (store) => store.directory,
  });
  await service.store.lock();
  await fs.writeFile(settingsFile + '.tmp', JSON.stringify(settings));
  await fs.rename(settingsFile + '.tmp', settingsFile);
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${service.server.address().port}`;
  const isolated = session.fromPartition(
    'journal-' + randomBytes(12).toString('hex'),
  );
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowRequest(details.url, origin) }),
  );
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    if (isAppUrl(details.url, origin))
      details.requestHeaders['X-Journal-Desktop-Token'] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
  isolated.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'",
        ],
      },
    }),
  );
  window = new BrowserWindow({
    title: '盘口手记',
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      session: isolated,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  window.webContents.on('will-prevent-unload', () => {
    allowClose = false;
    preparingClose = false;
    clearTimeout(closeTimer);
  });
  window.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (preparingClose) return;
    if (locked) {
      allowClose = true;
      window.close();
      return;
    }
    preparingClose = true;
    window.webContents.send('journal:prepare-close');
    closeTimer = setTimeout(() => {
      preparingClose = false;
      void dialog.showMessageBox(window, {
        type: 'warning',
        message: '尚未确认编辑已保存，暂未退出。',
        detail: '请等待当前操作完成，检查保存状态后再关闭窗口。',
      });
    }, 15000);
  });
  ipcMain.handle('journal:close-ready', async (event, ok) => {
    if (!validSender(event, window, origin) || !preparingClose) return;
    clearTimeout(closeTimer);
    preparingClose = false;
    if (ok === true) {
      allowClose = true;
      window.close();
    } else
      await dialog.showMessageBox(window, {
        type: 'warning',
        message: '资料尚未保存，已保留窗口。',
        detail: '请检查页面保存提示，完成保存后再退出。',
      });
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, origin)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  ipcMain.handle('journal:choose-directory', async (event) => {
    if (!validSender(event, window, origin) || locked || quitting)
      throw new Error('不允许的请求。');
    if (dialogBusy) return null;
    dialogBusy = true;
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '选择新的空资料文件夹',
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      return result.canceled ? null : result.filePaths[0] || null;
    } finally {
      dialogBusy = false;
    }
  });
  ipcMain.handle('journal:lock-settings', async (event) => {
    if (!validSender(event, window, origin) || dialogBusy || locked || quitting)
      throw new Error('不允许的请求。');
    dialogBusy = true;
    try {
      await showAuthWindow({ parent: window, auth, mode: 'settings' });
    } finally {
      dialogBusy = false;
    }
  });
  ipcMain.handle('journal:lock', async (event) => {
    if (!validSender(event, window, origin) || dialogBusy || locked || quitting)
      throw new Error('不允许的请求。');
    if (!auth.enabled) {
      await dialog.showMessageBox(window, {
        message: '请先在本地应用锁设置中设置密码。',
        type: 'info',
      });
      return;
    }
    dialogBusy = true;
    locked = true;
    window.hide();
    try {
      await service.store.queue;
      if (await showAuthWindow({ auth, mode: 'unlock' })) {
        locked = false;
        window.show();
      } else app.quit();
    } finally {
      dialogBusy = false;
    }
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
  uiLoaded = true;
}
