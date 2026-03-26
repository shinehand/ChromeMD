# ChromeMD — Markdown Reader & Editor

A Chrome extension that lets you **view** and **edit** Markdown (`.md`) files directly in the browser with GitHub-style rendering, syntax highlighting, and a one-click save (download) feature.

## Features

| Feature | Description |
|---------|-------------|
| 📄 **View Mode** | Renders Markdown as beautiful GitHub-style HTML |
| ✏️ **Edit Mode** | Full-screen textarea editor for the raw Markdown source |
| 🔀 **Split Mode** | Side-by-side editor and live preview |
| 💾 **Save** | Downloads the (modified) file back to disk (`Ctrl/Cmd+S`) |
| 🎨 **Syntax Highlighting** | Code blocks highlighted via highlight.js (GitHub theme) |
| ⌨️ **Keyboard Shortcuts** | `Ctrl+E` / `Cmd+E` toggles edit mode; `Ctrl+S` / `Cmd+S` saves |

## Supported file extensions

`.md` · `.markdown` · `.mdown` · `.mkd` · `.mkdn` · `.mdwn` · `.mdtxt` · `.mdtext`

Works on both **local files** (`file://`) and **remote URLs** (`http://` / `https://`).

## Installation

### Development / Unpacked

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the root folder of this repository.
5. ✅ The extension is now installed.

### Allow access to local files (important!)

To view local `.md` files (`file://` URLs) you must enable file access:

1. Go to `chrome://extensions/`.
2. Find **ChromeMD** and click **Details**.
3. Enable **Allow access to file URLs**.

## Usage

1. Open any `.md` file in Chrome (drag-and-drop onto a tab, or use `File → Open File`).
2. ChromeMD intercepts the request and renders it instantly.
3. Use the toolbar buttons to switch between **View**, **Split**, and **Edit** modes.
4. Make your changes in the editor.
5. Press `Ctrl+S` (or click **💾 Save**) to download the updated file.

## Project structure

```
ChromeMD/
├── manifest.json           # Chrome Extension Manifest V3
├── content.js              # Content script – view/edit/save logic
├── styles.css              # Toolbar & GitHub-style markdown CSS
├── lib/
│   ├── marked.min.js       # Markdown parser (marked v9)
│   ├── highlight.min.js    # Syntax highlighter (highlight.js v11)
│   └── highlight-github.min.css  # GitHub syntax-highlight theme
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Libraries used

| Library | Version | License |
|---------|---------|---------|
| [marked](https://github.com/markedjs/marked) | 9.x | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.x | BSD-3-Clause |

## License

MIT
