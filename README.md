# Table paste suggestion repro (CKEditor 5)

A minimal page that uses only standard CKEditor 5 plugins: `ckeditor5` and `ckeditor5-premium-features` 48.5.1,
which bring Cloud Services SDK 54.2.10. It reproduces two problems:

1. **A re-sent save loses its attributes.** If a suggestion save fails during a reconnect, real-time collaboration
   sends it again after the reconnect, but without `attributes`. Cloud Services then stores `attributes: null`.
2. **A table paste suggestion without `tablePasteChainId` hangs the editor on load.** CKEditor treats every
   suggestion without that attribute as part of the same paste and chains them all. With a word replacement above
   the table, `Suggestion.head` then loops forever.

## What the page contains

- The editor uses standard plugins only: Essentials, Paragraph, Bold, Italic, Table, TableToolbar, CloudServices,
  Comments, TrackChanges, RealTimeCollaborativeEditing, RealTimeCollaborativeComments and
  RealTimeCollaborativeTrackChanges. Every option is a standard one.
- The buttons above the editor are a test harness and do not change the editor:
  - **A. Simulate a dead connection** drops all data on the open WebSocket for 15 s, then closes it, and socket.io
    reconnects on its own. This is what happens when the network dies but the connection still looks open.
  - **B. Remove tablePasteChainId** calls the public `suggestion.removeAttribute()`, which also saves the
    attributes to Cloud Services.
  - **Show table paste suggestions** writes the in-memory suggestions to the log.
- The status line shows the connection state, the time since the last server ping, and the number of pending saves.

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env` and fill in:
   - `VITE_CK_LICENSE_KEY`: a license key with real-time collaboration and track changes.
   - `VITE_CK_WEBSOCKET_URL`: the WebSocket URL of your Cloud Services environment.
   - `VITE_CK_TOKEN`: a token for that environment that allows writing to every channel (`"*"`), because the page
     creates a new channel for each document. The token is used as is, without refreshing.
3. Run `npm run dev`, then open http://localhost:5173.

Each visit without `?channel=` creates a new document, and the channel id is added to the URL. A reload opens the
same document. **New document** starts a clean one.

To check what Cloud Services stored, read the suggestions through the REST API:
`GET /api/v5/<environment id>/suggestions?document_id=<channel id>`.

## Scenario A: a simulated dead connection (both problems)

1. Open a new document. Check that **Connection** shows `connected` and that track changes is on (the page turns it
   on).
2. In the first paragraph, select the word "rely" and type "depend". This creates a word replacement.
3. In the source table, select the three cells of the first column with the mouse and copy them.
4. Click **A. Simulate a dead connection (15 s)**.
5. Within 15 seconds, click the first cell of the empty column in the target table and paste. The editor is not
   locked, because the browser still thinks the connection is open.
6. Wait for `Connection: disconnected` and then `Connection: connected` in the log, and for **Unsaved changes** `0`.
7. Click **Show table paste suggestions** and write down the ids. In memory they still have `tablePasteChainId`.
8. Read the suggestions through the REST API.
9. Do not accept or reject the pasted suggestions. Reload the page.

**Expected if both problems are present:**
- In step 8, the `tablePaste` records have `attributes: null`.
- In step 9, the tab hangs at 100% CPU.

Steps 4–5 can miss: if the save got through before the connection died, its attributes are kept. If the records
have their attributes in step 8, start a new document and try again.

## Scenario A with a real network drop

Use a phone hotspot and turn off the phone's mobile data. The computer stays on Wi-Fi, so the browser does not see
the drop: the connection is half-open.

The client finds out that the connection is dead only from the heartbeat: when **Last server ping** gets past the
"closes after" value, socket.io closes the socket with `ping timeout`. So:

- If the internet comes back before that, the connection can survive: TCP delivers the stuck data late, the save
  succeeds with its attributes, and there is nothing to reproduce.
- If the phone's address changed meanwhile (turning mobile data off and on usually does that), the old connection
  is dead, but the client keeps waiting until the ping timeout. A reload before that loses the changes that were
  not saved. The page asks before such a reload. **Unsaved changes** shows how many saves are still pending.

Steps:

1. Do steps 1–3 of scenario A.
2. Turn off mobile data on the phone.
3. Paste into the target table.
4. Keep the internet off until the log shows `Socket closed: ping timeout` and `Connection: disconnected`.
5. Turn mobile data back on. Wait for `Connection: connected` and **Unsaved changes** `0`.
6. Continue from step 7 of scenario A.

## Scenario B: the hang only

1. Do steps 1–3 of scenario A.
2. Without reloading the page, click the first cell of the empty column in the target table and paste.
3. Click **B. Remove tablePasteChainId**, wait a few seconds, then reload.

**Expected if problem 2 is present:** the tab hangs at 100% CPU on load.

The word replacement and the paste have to be made in the same session. If the page is reloaded between them, the
document loads.

## After a hang

Close the tab. The document stays broken, and opening it will hang again. Start the next attempt with
**New document**.
