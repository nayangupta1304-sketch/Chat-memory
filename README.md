# Chat Memory v3.1 (Team HACKIFY: Nidhi, Khushi, Nayan)

Install (for testing / mentors):
1. Unzip this folder. If an older Chat Memory is installed, REMOVE it first.
2. Chrome -> chrome://extensions -> turn on Developer mode (top right).
3. Load unpacked -> choose the unzipped folder (the one containing manifest.json).
4. Open chatgpt.com, claude.ai or gemini.google.com, refresh the tab, click the dark circle (bottom-right; drag it anywhere).
5. After editing any file: press the reload icon on the extension card, then refresh the chat tab.

What changed in v3.1
- Import by CONTENT, not file name: a backup saved as .json, .txt or .cmbak (renamed to anything) is recognised and asks for the BACKUP password plus your vault password. Any other file is imported as an ordinary file.
- Export formats: JSON, armored text, or Large backup (.cmbak, streamed, any size).
- Big storage: files are encrypted in 2 MB chunks, uploaded/downloaded chunk by chunk (4 GB per file), vault cap 25 GB with a storage meter in Settings.
- Password UI: strength label (Too weak ... Very strong), live rule checklist, Show password toggle.
- Docs: docs/ARCHITECTURE_AND_QNA.md (architecture, APIs, mentor Q&A). Tests: node dev/test.js, node dev/test-large.js, python3 dev/real-chromium-test.py and real-chromium-test2.py.

What changed in v3
- Strong passwords: a live checklist shows what is missing (12+ chars, upper, lower, number, symbol, no repeats / sequences / common words). Enforced again in background.js for the vault password, the restore password and the backup password.
- Import ANY file type (PDF, Word, PowerPoint, Excel, text, images, zip...) up to 20 MB each. The vault password is asked first. Text is read from txt/md/csv/json/html, docx/pptx/xlsx/odt/odp/ods/epub and (best effort) PDF; every original file is also kept, encrypted, and can be downloaded again. Backups include these files.
- Per-tab / per-site unlock: ChatGPT, Claude and Gemini (and every new tab) each ask for the vault password. Unlocking one does not unlock the others. Lock / idle / auto-lock closes all of them.
- Layout-proof capture: the dark circle reads the conversation from the page's main region, not from site class names. If a known layout (ChatGPT / Claude / Gemini) matches it is used for You/AI labels; if the layout changed, it falls back automatically. "One tap" button = capture + summarise + auto-name + sort into a folder named after the platform + save.
- Bug fixed: the dock used to redraw itself when the file picker closed, which threw away the chosen file (import and restore looked broken). It now redraws only when something really changed.
- Restore / import-backup pickers accept any file name or type.

Files
- manifest.json   MV3 config. Permissions: storage, unlimitedStorage, alarms, idle. No host permissions, no network.
- backupfmt.js    recognises backup files by content (json / txt / cmbak)
- background.js   service worker: ALL crypto (PBKDF2 -> AES-256-GCM), per-tab unlock, auto-lock, two-strikes erase, password re-check for import/export, encrypted file store, backups.
- pwcheck.js      shared password rules (used by the dock and by background.js).
- content.js      thin bridge on the chat page: the circle, the iframe, reading the page, inserting text.
- dock.html/js    the dock UI. Runs in the extension's OWN iframe, so the website can never see what you type.
- dev/            test.js (+shim.js): 50 vault checks, run: node dev/test.js
                  real-chromium-test.py: loads the extension in Chromium on fake claude.ai / chatgpt.com pages
                  (python3 dev/real-chromium-test.py /path/to/unzipped/folder). Delete dev/ before a Web Store upload.

Security rules built in
- TWO wrong passwords in a row ERASE the vault and its stored files (counter is stored on disk, so restarting the browser does not reset it). Import and Export each re-check the vault password; a wrong one counts as a strike.
- Export also asks for a separate strong BACKUP password; the file is encrypted with it. Recover an erased vault with Restore (backup file + backup password).
- Auto-lock: inactivity timer (alarms), OS idle / screen lock (idle), browser close (session storage).

Known limits: PDF text extraction is best effort (scanned PDFs or unusual fonts are kept as the original file without searchable text; there is no OCR). Files cannot be auto-attached to the chat box (that would depend on each site's layout): download the original and attach it yourself, or use "Add to chat" for extracted text.
