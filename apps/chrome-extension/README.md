# Cap Chrome extension

Record your tab, screen or camera and upload to **your own** Cap server.
The extension has no default server; you enter your Cap URL in Options.

There are two ways to install it.

## Option A: Load it directly (unpacked)

Use this for self-hosting, testing, or until a store listing exists.

1. Download `release/cap-chrome-extension-1.0.5.zip` from this folder.
2. Unzip it to a folder you will keep. Chrome loads it from that folder, so
   don't delete or move it.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one that
   contains `manifest.json`).
5. Copy the **ID** shown on the extension's card, 32 letters.
6. On your Cap server, set that ID:
   - YAML deploy: `chrome_extension_id: "<id>"` in your `config.yaml`, then redeploy.
   - Plain env: `CAP_CHROME_EXTENSION_ID=<id>`, then restart the web container.
   The server only accepts sign-ins from the extension ID it is configured with.
7. Click the extension icon, **Open Options**, enter your Cap URL
   (for example `https://cap.example.com`), and save.
8. Click the icon again and **Sign in**.

Notes:
- An unpacked extension's ID depends on the folder path. If you move the
  folder or load it on another computer, the ID changes and you must update the
  server setting. To keep one fixed ID everywhere, add a `"key"` to
  `manifest.json` (see Chrome's docs on
  [keeping a consistent extension ID](https://developer.chrome.com/docs/extensions/reference/manifest/key)).
- Chrome may show a "developer mode extensions" warning on startup. That is
  normal for unpacked extensions.
- To update: replace the folder contents with a newer zip, then click the
  reload icon on the extension's card. Same folder means same ID.

## Option B: Install from the Chrome Web Store

Use this once the extension is published there. The store version updates
automatically.

1. Open the extension's Chrome Web Store page and click **Add to Chrome**.
2. The store version has a fixed ID, shown on the store page URL and in
   `chrome://extensions`. Set that ID on your Cap server as in step 6 above.
3. Click the extension icon, **Open Options**, enter your Cap URL, save, then
   **Sign in**.

Remove any unpacked copy first so you don't have two Cap extensions installed.

## Build from source

```sh
bun install
cd apps/chrome-extension
bun run build        # output in dist/, load that folder with "Load unpacked"
```

`VITE_CAP_WEB_URL` at build time is optional. Leave it unset for a public build
so users choose their own server.
