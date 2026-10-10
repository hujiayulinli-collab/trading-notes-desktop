declare global {
  interface Window {
    journalDesktop?: {
      readonly localOnly: true;
      onBeforeClose: (callback: () => Promise<void>) => () => void;
      lock: () => Promise<void>;
      settings: () => Promise<void>;
      chooseDirectory: () => Promise<string | null>;
    };
  }
}
export const isDesktop = () =>
  typeof window !== 'undefined' && window.journalDesktop?.localOnly === true;
