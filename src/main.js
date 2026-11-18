import { Bold, ClassicEditor, CloudServices, Essentials, Italic, Paragraph, Table, TableToolbar, version } from "ckeditor5";
import {
  Comments,
  RealTimeCollaborativeComments,
  RealTimeCollaborativeEditing,
  RealTimeCollaborativeTrackChanges,
  TrackChanges,
} from "ckeditor5-premium-features";

import "ckeditor5/ckeditor5.css";
import "ckeditor5-premium-features/ckeditor5-premium-features.css";
import "./style.css";

const {
  VITE_CK_LICENSE_KEY: licenseKey,
  VITE_CK_WEBSOCKET_URL: webSocketUrl,
  VITE_CK_TOKEN: token,
} = import.meta.env;

const DEAD_CONNECTION_MS = 15 * 1000;

// Used only when the channel has no session in Cloud Services yet.
const INITIAL_DATA = `
<p>Plants rely on enzymes to break down starch, and farmers rely on soil microbes to recycle nutrients.</p>
<p>Source table: select the cells of the first column with the mouse and copy them.</p>
<figure class="table"><table><tbody>
  <tr><td>Amylase</td><td>Starch</td></tr>
  <tr><td>Lipase</td><td>Fat</td></tr>
  <tr><td>Protease</td><td>Protein</td></tr>
</tbody></table></figure>
<p>Target table: paste into the first cell of the empty column.</p>
<figure class="table"><table><tbody>
  <tr><td>Starch</td><td></td></tr>
  <tr><td>Fat</td><td></td></tr>
  <tr><td>Protein</td><td></td></tr>
</tbody></table></figure>
`;

const logElement = document.querySelector("#log");

const log = (message) => {
  logElement.textContent = `${new Date().toISOString()}  ${message}\n${logElement.textContent}`;
};

const getChannelId = () => {
  const url = new URL(window.location.href);
  const channelId = url.searchParams.get("channel");
  if (channelId) {
    return channelId;
  }

  const newChannelId = `tablepaste-repro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  url.searchParams.set("channel", newChannelId);
  window.history.replaceState(null, "", url);
  return newChannelId;
};

const describeSuggestion = (suggestion) =>
  `${suggestion.id}  ${suggestion.subType ? `${suggestion.type}:${suggestion.subType}` : suggestion.type}  ` +
  `inContent=${suggestion.isInContent}  attributes=${JSON.stringify(suggestion.attributes)}`;

const createEditor = (channelId) =>
  ClassicEditor.create(document.querySelector("#editor"), {
    licenseKey,
    plugins: [
      Essentials,
      Paragraph,
      Bold,
      Italic,
      Table,
      TableToolbar,
      CloudServices,
      Comments,
      TrackChanges,
      RealTimeCollaborativeEditing,
      RealTimeCollaborativeComments,
      RealTimeCollaborativeTrackChanges,
    ],
    toolbar: ["undo", "redo", "|", "bold", "italic", "|", "insertTable", "|", "trackChanges", "comment"],
    table: { contentToolbar: ["tableColumn", "tableRow", "mergeTableCells"] },
    comments: { editorConfig: { extraPlugins: [Bold, Italic] } },
    cloudServices: {
      tokenUrl: () => Promise.resolve(token),
      webSocketUrl,
    },
    collaboration: { channelId },
    sidebar: { container: document.querySelector("#sidebar") },
    trackChanges: { clipboardMode: "accept" },
    initialData: INITIAL_DATA,
  });

const setUpRepro = (editor) => {
  const trackChangesEditing = editor.plugins.get("TrackChangesEditing");
  const { connection } = editor.plugins.get("WebSocketGateway");

  const getTablePasteSuggestions = () =>
    trackChangesEditing.getSuggestions().filter((suggestion) => suggestion.subType?.startsWith("tablePaste"));

  const stateElement = document.querySelector("#state");
  stateElement.textContent = connection.state;
  connection.on("change:state", (evt, name, state) => {
    stateElement.textContent = state;
    log(`Connection: ${state}`);
  });

  // The client notices a dead connection only when the server's pings stop for pingInterval + pingTimeout.
  const manager = connection._socket.io;
  const pendingActions = editor.plugins.get("PendingActions");
  let lastPingAt = Date.now();

  const watchEngine = (engine) => {
    lastPingAt = Date.now();
    engine.on("ping", () => {
      lastPingAt = Date.now();
    });
  };
  watchEngine(manager.engine);
  manager.on("open", () => watchEngine(manager.engine));
  manager.on("close", (reason) => log(`Socket closed: ${reason}`));
  manager.on("reconnect_attempt", (attempt) => log(`Reconnect attempt ${attempt}`));

  const heartbeatElement = document.querySelector("#heartbeat");
  const pendingElement = document.querySelector("#pending");
  setInterval(() => {
    const { _pingInterval: pingInterval, _pingTimeout: pingTimeout } = manager.engine;
    const secondsSincePing = Math.round((Date.now() - lastPingAt) / 1000);
    heartbeatElement.textContent = `${secondsSincePing} s ago (closes after ${(pingInterval + pingTimeout) / 1000} s)`;
    pendingElement.textContent = String([...pendingActions].length);
  }, 1000);

  window.addEventListener("beforeunload", (event) => {
    if (pendingActions.hasAny) {
      event.preventDefault();
    }
  });

  // Scenario A. Outgoing and incoming data is dropped while the browser still thinks the socket is open, as on a
  // half-open connection. Then the socket is closed, as when the heartbeat notices it, and socket.io reconnects.
  const simulateDeadConnection = () => {
    const { engine } = connection._socket.io;
    const webSocket = engine.transport?.ws;
    if (!webSocket) {
      log(`The transport is "${engine.transport?.name}", not a WebSocket, so the simulation cannot run.`);
      return;
    }

    webSocket.send = () => {};
    webSocket.onmessage = () => {};
    log(`The connection is dead for ${DEAD_CONNECTION_MS / 1000} s. The editor is not locked. Paste into the table now.`);

    setTimeout(() => {
      webSocket.close();
      log("Closed the dead WebSocket. Wait for 'Connection: connected', then reload the page.");
    }, DEAD_CONNECTION_MS);
  };

  // Scenario B. The chain id is removed through the public API, which also saves the attributes to Cloud Services.
  const removeChainIds = () => {
    const suggestions = getTablePasteSuggestions().filter((suggestion) => suggestion.attributes?.tablePasteChainId);
    suggestions.forEach((suggestion) => suggestion.removeAttribute("tablePasteChainId"));
    log(`Removed tablePasteChainId from ${suggestions.length} suggestion(s). Wait a few seconds, then reload the page.`);
  };

  const showSuggestions = () => {
    const suggestions = getTablePasteSuggestions();
    log(
      [
        `Table paste suggestions in the editor (${suggestions.length} of ${trackChangesEditing.getSuggestions().length}):`,
        ...suggestions.map(describeSuggestion),
      ].join("\n")
    );
  };

  const deadConnectionButton = document.querySelector("#dead-connection");
  const removeChainIdButton = document.querySelector("#remove-chain-id");
  const showSuggestionsButton = document.querySelector("#show-suggestions");

  deadConnectionButton.addEventListener("click", simulateDeadConnection);
  removeChainIdButton.addEventListener("click", removeChainIds);
  showSuggestionsButton.addEventListener("click", showSuggestions);
  [deadConnectionButton, removeChainIdButton, showSuggestionsButton].forEach((button) => {
    button.disabled = false;
  });

  if (!editor.commands.get("trackChanges").value) {
    editor.execute("trackChanges");
  }
};

const start = async () => {
  document.querySelector("#version").textContent = version;
  document.querySelector("#new-document").addEventListener("click", () => {
    window.location.href = window.location.pathname;
  });

  if (!licenseKey || !webSocketUrl || !token) {
    log("Fill in .env first (see README.md), then restart `npm run dev`.");
    return;
  }

  const channelId = getChannelId();
  document.querySelector("#channel").textContent = channelId;
  log(`Opening channel ${channelId}`);

  const editor = await createEditor(channelId);
  window.editor = editor;
  setUpRepro(editor);
  log("Editor is ready. Track changes is on.");
};

start().catch((error) => {
  log(`Error: ${error?.message || error}`);
  throw error;
});
