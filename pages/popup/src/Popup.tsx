import '@src/Popup.css';
import { Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

const HELPER_URL = 'http://127.0.0.1:5477/sandbox-id';
const DEFAULT_LOCAL_DATABASE_URL = 'postgresql://postgres:mysecretpassword@localhost:5432/postgres';
const SESSION_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const LIVE_SANDBOX_WINDOW_SECONDS = 24 * 60 * 60;
const SETTINGS_STORAGE_KEY = 'modalLogsSettings';
const PRODUCTION_TARGET = 'dev-sandbox';

const targetOptions = [
  { label: 'slavko-dev-sandbox', value: 'slavko-dev-sandbox' },
  { label: 'leo-dev-sandbox', value: 'leo-dev-sandbox' },
  { label: 'iaculch-dev-sandbox', value: 'iaculch-dev-sandbox' },
] as const;

type TargetValue = (typeof targetOptions)[number]['value'];
type DatabaseKey = 'local' | 'prod';

type Settings = {
  selectedTarget: TargetValue;
  localDatabaseUrl: string;
  prodDatabaseUrl: string;
};

type StoredSettings = Partial<Settings>;

type SandboxResponse = {
  modalId?: string;
  error?: string;
};

type PageContext = {
  databaseKey: DatabaseKey;
  sessionId: string;
};

const defaultSettings: Settings = {
  selectedTarget: 'slavko-dev-sandbox',
  localDatabaseUrl: DEFAULT_LOCAL_DATABASE_URL,
  prodDatabaseUrl: '',
};

const logDebug = (message: string, details?: Record<string, unknown>) => {
  console.log(`[Modal Helper] ${message}`, details || {});
};

const summarizeDatabaseUrl = (databaseUrl: string) => {
  if (!databaseUrl) {
    return { configured: false };
  }

  try {
    const parsedUrl = new URL(databaseUrl);

    return {
      configured: true,
      database: parsedUrl.pathname.replace(/^\//, ''),
      host: parsedUrl.hostname,
      port: parsedUrl.port || 'default',
      protocol: parsedUrl.protocol,
    };
  } catch {
    return {
      configured: true,
      parseable: false,
    };
  }
};

const getActiveTabUrl = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  logDebug('Active tab resolved', { url: tab.url });

  return tab.url;
};

const getPageContextFromUrl = (tabUrl?: string): PageContext | null => {
  if (!tabUrl) {
    return null;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(tabUrl);
  } catch {
    return null;
  }

  const isLocalHost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  const isAlloyApp = parsedUrl.hostname === 'alloy.app' || parsedUrl.hostname.endsWith('.alloy.app');

  if (!isLocalHost && !isAlloyApp) {
    logDebug('Active tab is not an Alloy session host', { host: parsedUrl.hostname });
    return null;
  }

  const match = parsedUrl.pathname.match(SESSION_ID_PATTERN);

  if (!match) {
    logDebug('No session ID found in active tab URL', { host: parsedUrl.hostname, pathname: parsedUrl.pathname });
    return null;
  }

  let databaseKey: DatabaseKey = 'local';

  if (isAlloyApp) {
    databaseKey = 'prod';
  }

  return {
    databaseKey,
    sessionId: match[0],
  };
};

const loadSettings = async () => {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const savedSettings = stored[SETTINGS_STORAGE_KEY] as StoredSettings | undefined;
  const loadedSettings = {
    ...defaultSettings,
    ...savedSettings,
  };

  const isKnownTarget = targetOptions.some(targetOption => targetOption.value === loadedSettings.selectedTarget);

  if (!isKnownTarget) {
    logDebug('Stored target was unknown, falling back to default', {
      savedTarget: loadedSettings.selectedTarget,
      defaultTarget: defaultSettings.selectedTarget,
    });

    return {
      ...loadedSettings,
      selectedTarget: defaultSettings.selectedTarget,
    };
  }

  logDebug('Settings loaded', {
    localDatabase: summarizeDatabaseUrl(loadedSettings.localDatabaseUrl),
    prodDatabase: summarizeDatabaseUrl(loadedSettings.prodDatabaseUrl),
    selectedTarget: loadedSettings.selectedTarget,
  });

  return loadedSettings;
};

const saveSettings = async (settings: Settings) => {
  logDebug('Saving settings', {
    localDatabase: summarizeDatabaseUrl(settings.localDatabaseUrl),
    prodDatabase: summarizeDatabaseUrl(settings.prodDatabaseUrl),
    selectedTarget: settings.selectedTarget,
  });

  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
};

const getTargetForPage = (pageContext: PageContext | null, currentSettings: Settings) => {
  if (pageContext?.databaseKey === 'prod') {
    return PRODUCTION_TARGET;
  }

  return currentSettings.selectedTarget;
};

const getModalId = async (sessionId: string, databaseKey: DatabaseKey, currentSettings: Settings) => {
  logDebug('Requesting Modal sandbox ID from helper', {
    databaseKey,
    localDatabase: summarizeDatabaseUrl(currentSettings.localDatabaseUrl),
    prodDatabase: summarizeDatabaseUrl(currentSettings.prodDatabaseUrl),
    sessionId,
  });

  const response = await fetch(HELPER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      databaseKey,
      localDatabaseUrl: currentSettings.localDatabaseUrl,
      prodDatabaseUrl: currentSettings.prodDatabaseUrl,
      sessionId,
    }),
  });
  const result = (await response.json()) as SandboxResponse;

  logDebug('Helper response received', {
    hasModalId: Boolean(result.modalId),
    ok: response.ok,
    status: response.status,
  });

  if (!response.ok) {
    throw new Error(result.error || 'The helper could not find a sandbox for this session.');
  }

  if (!result.modalId) {
    throw new Error('The helper returned an empty sandbox ID.');
  }

  return result.modalId;
};

const createModalLogsUrl = (target: string, modalId: string) => {
  const end = Date.now() / 1000;
  const start = end - LIVE_SANDBOX_WINDOW_SECONDS;
  const params = new URLSearchParams({
    activeTab: 'sandboxes',
    start: start.toString(),
    end: end.toString(),
    live: 'true',
    sandboxSection: 'sandboxes',
    sandboxId: modalId,
  });

  params.append('sandboxId', modalId);

  const modalLogsUrl = `https://modal.com/apps/alloy/main/deployed/${target}?${params.toString()}`;

  logDebug('Modal URL created', {
    modalId,
    target,
    url: modalLogsUrl,
  });

  return modalLogsUrl;
};

const getFriendlyError = (error: unknown) => {
  if (error instanceof TypeError) {
    return 'Could not reach the local helper. Start it with docker compose up modal-helper.';
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong while opening Modal logs.';
};

const Popup = () => {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [draftSettings, setDraftSettings] = useState<Settings>(defaultSettings);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    loadSettings()
      .then(loadedSettings => {
        setSettings(loadedSettings);
        setDraftSettings(loadedSettings);
      })
      .catch(() => {
        setErrorMessage('Could not load extension settings.');
      });

    getActiveTabUrl()
      .then(tabUrl => {
        const initialPageContext = getPageContextFromUrl(tabUrl);
        setPageContext(initialPageContext);
        logDebug('Initial page context resolved', initialPageContext || { found: false });
      })
      .catch(() => {
        setPageContext(null);
      });
  }, []);

  const environmentName = getTargetForPage(pageContext, settings);

  const saveDraftSettings = async () => {
    setErrorMessage('');
    await saveSettings(draftSettings);
    setSettings(draftSettings);
    setIsSettingsOpen(false);
    setStatusMessage('Settings saved.');
  };

  const openSettings = () => {
    logDebug('Opening settings');
    setDraftSettings(settings);
    setErrorMessage('');
    setIsSettingsOpen(true);
  };

  const openModalLogs = async () => {
    logDebug('Open in Modal clicked');
    setIsLoading(true);
    setErrorMessage('');
    setStatusMessage('Finding the current Alloy session...');

    try {
      const tabUrl = await getActiveTabUrl();
      const currentPageContext = getPageContextFromUrl(tabUrl);
      setPageContext(currentPageContext);
      logDebug('Current page context resolved', currentPageContext || { found: false });

      if (!currentPageContext) {
        throw new Error('Open this from a localhost or alloy.app session page with a session ID in the URL.');
      }

      const databaseUrl = settings[`${currentPageContext.databaseKey}DatabaseUrl`];

      if (!databaseUrl.trim()) {
        throw new Error(`Add a ${currentPageContext.databaseKey} database URL in settings first.`);
      }

      const modalTarget = getTargetForPage(currentPageContext, settings);

      logDebug('Using Modal target and database key', {
        databaseKey: currentPageContext.databaseKey,
        modalTarget,
      });

      setStatusMessage(`Looking up ${modalTarget}...`);
      const modalId = await getModalId(currentPageContext.sessionId, currentPageContext.databaseKey, settings);
      const modalLogsUrl = createModalLogsUrl(modalTarget, modalId);

      setStatusMessage(`Opening ${modalTarget}...`);
      await chrome.tabs.create({ url: modalLogsUrl });
      logDebug('Opened Modal tab', { modalTarget });
    } catch (error) {
      console.error('[Modal Helper] Failed to open Modal sandbox', error);
      setStatusMessage('Unable to open Modal sandbox.');
      setErrorMessage(getFriendlyError(error));
    } finally {
      setIsLoading(false);
    }
  };

  let buttonText = 'Open in Modal';

  if (isLoading) {
    buttonText = 'Opening...';
  }

  return (
    <main className="modal-helper">
      <section className="modal-helper__panel">
        {!isSettingsOpen && (
          <>
            <div className="modal-helper__action-row">
              <button className="modal-helper__button" type="button" onClick={openModalLogs} disabled={isLoading}>
                {buttonText}
              </button>

              <button className="modal-helper__icon-button" type="button" onClick={openSettings} aria-label="Open database settings">
                <SettingsIcon aria-hidden="true" size={17} strokeWidth={2.25} />
              </button>
            </div>

            <p className="modal-helper__environment">{environmentName}</p>
          </>
        )}

        {isSettingsOpen && (
          <form className="modal-helper__settings" onSubmit={event => event.preventDefault()}>
            <div className="modal-helper__settings-header">
              <div>
                <p className="modal-helper__eyebrow">Settings</p>
                <h1>Database URLs</h1>
              </div>
              <button className="modal-helper__back-button" type="button" onClick={() => setIsSettingsOpen(false)}>
                Back
              </button>
            </div>

            <label className="modal-helper__field">
              <span>Dev sandbox</span>
              <select
                value={draftSettings.selectedTarget}
                onChange={event =>
                  setDraftSettings({
                    ...draftSettings,
                    selectedTarget: event.target.value as TargetValue,
                  })
                }>
                {targetOptions.map(targetOption => (
                  <option key={targetOption.value} value={targetOption.value}>
                    {targetOption.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="modal-helper__field">
              <span>Local database URL, used on localhost</span>
              <input
                type="text"
                value={draftSettings.localDatabaseUrl}
                onChange={event =>
                  setDraftSettings({
                    ...draftSettings,
                    localDatabaseUrl: event.target.value,
                  })
                }
                placeholder={DEFAULT_LOCAL_DATABASE_URL}
              />
            </label>

            <label className="modal-helper__field">
              <span>Prod database URL, used on alloy.app</span>
              <input
                type="text"
                value={draftSettings.prodDatabaseUrl}
                onChange={event =>
                  setDraftSettings({
                    ...draftSettings,
                    prodDatabaseUrl: event.target.value,
                  })
                }
                placeholder="postgresql://user:password@host:5432/postgres"
              />
            </label>

            <button className="modal-helper__button" type="button" onClick={saveDraftSettings}>
              Save settings
            </button>
          </form>
        )}

        <p className="modal-helper__status">{statusMessage}</p>
        {errorMessage && <p className="modal-helper__error">{errorMessage}</p>}
      </section>
    </main>
  );
};

export default Popup;
