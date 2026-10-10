export function isAppUrl(value, origin) {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}
export function allowRequest(value, origin) {
  if (isAppUrl(value, origin)) return true;
  return value.startsWith('blob:' + origin + '/') || value.startsWith('data:');
}
export function validSender(event, window, origin) {
  return (
    !!window &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isAppUrl(event.senderFrame.url, origin)
  );
}
