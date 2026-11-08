(() => {
  if (location.origin !== 'https://chatgpt.com' || window !== window.top) return;

  const stateKey = 'codex.browser.persistedAtomState';
  const { get, put } = IDBObjectStore.prototype;
  const readResult = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get;
  const isChatGPTState = (store, key) =>
    key === stateKey && store.name === 'records' && store.transaction.db.name === 'codex-browser-host';
  let pageState;

  IDBObjectStore.prototype.get = function (key) {
    const request = get.apply(this, arguments);
    if (isChatGPTState(this, key)) {
      Object.defineProperty(request, 'result', { get() {
        const stored = readResult.call(this);
        if (pageState !== undefined) return structuredClone(pageState);
        if (stored && typeof stored === 'object') {
          delete stored['composer-prompt-drafts-v2'];
          delete stored['chatgpt-conversation-prompt-drafts-v2'];
        }
        return stored;
      } });
    }
    return request;
  };

  IDBObjectStore.prototype.put = function (value, key) {
    if (!isChatGPTState(this, key)) return put.apply(this, arguments);
    // ChatGPT stores these drafts in a shared snapshot with other preferences.
    // Keep this tab's snapshot in memory so it cannot overwrite either.
    const request = get.call(this, key);
    const snapshot = structuredClone(value);
    request.addEventListener('success', () => { pageState = snapshot; });
    Object.defineProperty(request, 'result', { get() {
      readResult.call(this);
      return key;
    } });
    return request;
  };
})();
