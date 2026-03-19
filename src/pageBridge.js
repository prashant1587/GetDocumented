const PAGE_BRIDGE_SOURCE = 'getdocumented-page-bridge';
const PAGE_BRIDGE_REQUEST = 'GETDOCUMENTED_PAGE_BRIDGE_REQUEST';
const PAGE_BRIDGE_EVENT = 'GETDOCUMENTED_PAGE_BRIDGE_EVENT';
const AUTH_TOKEN_KEY = 'getdocumented.auth.token';
const AUTH_USER_KEY = 'getdocumented.auth.user';

if (!window.__getdocumentedPageBridgeInstalled) {
  window.__getdocumentedPageBridgeInstalled = true;

  const readUser = () => {
    const rawUser = window.localStorage.getItem(AUTH_USER_KEY);
    if (!rawUser) return null;

    try {
      return JSON.parse(rawUser);
    } catch {
      return null;
    }
  };

  const emitSession = () => {
    window.postMessage(
      {
        source: PAGE_BRIDGE_SOURCE,
        type: PAGE_BRIDGE_EVENT,
        payload: {
          token: window.localStorage.getItem(AUTH_TOKEN_KEY),
          user: readUser(),
        },
      },
      window.location.origin
    );
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== PAGE_BRIDGE_REQUEST || event.data?.source !== 'getdocumented-extension') return;
    emitSession();
  });

  window.addEventListener('storage', (event) => {
    if (event.key === AUTH_TOKEN_KEY || event.key === AUTH_USER_KEY) {
      emitSession();
    }
  });

  emitSession();
}
