/* ============================================================
   Bridge between the Recall UI and the Rust backend.

   Everything that crosses the IPC boundary goes through here, so
   the rest of the page never touches Tauri directly. The API key
   lives in the OS keychain and is never handed back to this page —
   the UI only ever learns whether one is stored.

   Every call rejects with { code, message }; `code` is stable and
   safe to branch on, `message` is for the reader.
   ============================================================ */
(function () {
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

  const unavailable = () => Promise.reject({
    code: 'unavailable',
    message: 'Recall is running outside the desktop app, so it cannot reach Claude.',
  });

  const call = (command, args) => (invoke ? invoke(command, args) : unavailable());

  window.RecallBackend = {
    /* False when index.html is opened straight in a browser. */
    available: Boolean(invoke),

    /* -> { connected, model } */
    status: () => call('claude_status'),

    /* Verifies the key before storing it, so a typo fails here. -> { connected, model } */
    connect: (apiKey) => call('claude_connect', { apiKey }),

    /* -> { connected, model } */
    disconnect: () => call('claude_disconnect'),

    /* -> { verdict, note } */
    assess: (fullText, span) => call('claude_assess', { fullText, span }),

    /* The whole library as one JSON string, or null before the first save. */
    libraryLoad: () => call('library_load'),

    /* Persists the whole library as one JSON string. -> null */
    librarySave: (data) => call('library_save', { data }),

    /* ---- files folder: source material Recall reads from and writes to ---- */

    /* Absolute path of the current files folder. -> string */
    filesFolder: () => call('files_folder'),

    /* Native folder picker; remembers the choice. -> new path, or null if cancelled */
    filesFolderPick: () => call('files_folder_pick'),

    /* -> [{ name, size, modified_ms }], newest first */
    filesList: () => call('files_list'),

    /* Native multi-file picker; copies chosen files in. -> [name, ...] added */
    filesImport: () => call('files_import'),

    /* Opens one file in the OS default app. -> null */
    filesOpen: (name) => call('files_open', { name }),

    /* Reveals the folder itself in the system file browser. -> null */
    filesReveal: () => call('files_reveal'),

    /* Deletes one file (a no-op if already gone). -> null */
    filesDelete: (name) => call('files_delete', { name }),
  };
})();
