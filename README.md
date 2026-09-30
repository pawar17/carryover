# Carryover Notebook

A private, on-device notebook for work knowledge-transfer (KT) notes. Photograph your daily notebook pages, turn them into text on your own device, split each page into topics, and file them into sections you control, each tagged with the system, team, process and environment it applies to.

No server, no account, no analytics, no AI service. It runs entirely in your browser and is hosted as static files on GitHub Pages.

## What it does

| Area | What you get |
|---|---|
| **Capture** | Add page photos → text is recognized on-device → words it's unsure of are marked `⟦like this⟧` → you split the page into topics with `---` → file each note. Or paste text from iPhone Live Text. The photo is kept (encrypted) next to each note. |
| **Organize yourself** | Create, rename, recolor, reorder and delete sections. Drag notes onto a tab to move them, onto another note to reorder. Pin notes. Suggestions are just suggestions. |
| **Context** | Every note records *System / app*, *Team / owner*, *Process / step*, *Environment*, *Learned from* and *Status* (Confirmed / Needs verification / Outdated). Group or filter the notebook by any of these. |
| **Context map** | One card per system: its teams, processes, environments, terms, notes and open questions. Shows what applies to what. |
| **Glossary** | Define team acronyms once; they're underlined in every note and explain themselves on tap. Undefined acronyms in your notes are listed for you to define. |
| **Quick lookup** | Press `/` or `⌘K` / `Ctrl+K` anywhere. Fuzzy search across notes, terms and answered questions. |
| **Ask** | Type a question. You get the exact lines from your notes that answer it, with where they apply, plus relevant definitions and answered questions. |
| **Explanations** | Each note page shows a short summary, the terms it uses, open questions, related notes and the original page. |
| **Follow-ups** | Lines ending in `?` become questions to ask a colleague; lines starting `TODO:` or `[ ]` become action items. Record answers, and they become searchable knowledge. |
| **Summaries** | "Summarize section" builds a cheat sheet: key lines per system, terms, and what's still open. |

## Deploy to GitHub Pages

1. Create a new GitHub repository (it can be **public**: only the app's code is in it, never your notes).
2. Upload everything in this folder to the repository root, including the `vendor/` folder and the hidden `.nojekyll` file.
   - Web: *Add file → Upload files*, drag the folder contents in, commit.
   - Or command line:
     ```bash
     git init && git add . && git commit -m "Carryover"
     git branch -M main
     git remote add origin https://github.com/<you>/<repo>.git
     git push -u origin main
     ```
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. After a minute, open `https://<you>.github.io/<repo>/`. Create a passphrase and start.
5. On iPhone: open it in Safari → Share → **Add to Home Screen** to use it like an app.

To try it locally first: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`.

## How your data is stored

- **Where:** in your browser's IndexedDB, on the device you use. Nothing is uploaded, including to GitHub. Each device/browser has its own separate notebook.
- **Encryption:** every record (notes, glossary, questions, page photos) is encrypted with **AES-256-GCM**. The key is derived from your passphrase with **PBKDF2-SHA-256, 600,000 iterations** and a random salt. The key exists only in memory while unlocked; the passphrase is never stored.
- **Auto-lock** after inactivity (default 10 minutes; configurable). Locking wipes the key and the decrypted notes from memory.
- **Locked-down page:** a Content Security Policy blocks all third-party scripts and network connections. All libraries and fonts are served from this repo. You can confirm in your browser's dev tools (Network tab) that nothing leaves the page.
- **Backups:** *Settings → Download encrypted backup* saves a `.carryover` file that's still encrypted. Use it to move to a new device (*Restore a backup file* on the lock screen). Keep backups; clearing site data or losing the device deletes the local copy.
- **No recovery:** if you forget the passphrase, the notes can't be decrypted by anyone.

What this does **not** protect against: someone using your device while it's unlocked, malware on the device, or a weak passphrase. And encryption doesn't make it OK to take notes out of work systems if your employer's policy forbids it. **Check your company's data policy before putting work KT notes in any personal app, this one included.**

## How handwriting gets transcribed without a cloud AI

1. **Built-in recognizer (Tesseract, runs locally in WebAssembly).** The photo is straightened, contrast-boosted, then read in your browser. It's good on neat print and weak on joined-up handwriting.
2. **iPhone Live Text (recommended for handwriting).** Live Text runs on the phone and reads handwriting much better. Open the photo → tap the Live Text icon → Select All → Copy → paste into *Or paste text*. Attach the photo too if you want it kept.
3. **You review before anything is saved.** Uncertain words are marked `⟦ ⟧`. *Next unsure word* jumps through them, the photo sits next to the text (tap to zoom), and pages the recognizer scored low tell you it may be faster to retype.

**If a word is illegible:** leave it marked. The note gets flagged in the *To check* tab with the status *Needs verification*, and the original photo is one tap away. You fix it later, or add a question in Follow-ups to confirm with a colleague.

## How summaries and answers work without Claude

- **Extractive summaries:** each line is scored by how distinctive its words are across all your notes (TF-IDF), with a boost for rules, deadlines, numbers, bold terms and glossary terms. The top lines are shown in their original order. Summaries are made only of your own words, so they can't invent facts.
- **Ask** finds the lines most similar to your question and shows them with the note, section, system and environment they came from.
- **Section suggestions** and **related notes** use the same similarity scoring against what's already filed.
- **Optional on-device AI:** in recent desktop Chrome, a built-in model (Gemini Nano) runs locally. When available, a ✨ button appears for written summaries and answers. Text still never leaves the device. Safari and iPhone don't offer this, and the app works fully without it.

## Files

```
index.html              page shell and security policy
css/styles.css          notebook look (light + dark)
js/app.js               the app
js/vault.js             encryption + IndexedDB storage
js/text.js              summaries, suggestions, similarity, splitting
js/ocr.js               on-device text recognition
js/ai.js                optional Chrome on-device AI
vendor/                 Tesseract.js (Apache-2.0), MiniSearch (MIT), fonts (OFL)
```
