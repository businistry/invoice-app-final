# Invoice Approval PDF App

Private browser app for uploading invoice PDFs, suggesting GL codes, stamping approval information, and saving finalized PDFs as `STLMO_Vendor Name_Invoice Number.pdf`.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

For the production-style app:

```bash
npm start
```

Open `http://localhost:3001` on the computer running the app.

## Configuration

Copy `.env.example` to `.env` if you want to set:

- `APP_PASSWORD`: enables browser Basic Auth for the whole app.
- `HOST`: use `0.0.0.0` to allow another computer on the network to reach the app.
- `OPENAI_API_KEY`: enables AI PDF extraction for digital and scanned invoices.
- `OPENAI_MODEL`: defaults to `gpt-5-mini`.
- `GM_INITIALS`: default initials used on the stamp.
- `GL_SEED_PATH`: CSV path used to seed GL codes when the local database is empty.
- `GOOGLE_APPLICATION_CREDENTIALS`: path to a Google service account JSON file for Drive uploads.
- `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`: alternative to `GOOGLE_APPLICATION_CREDENTIALS`; accepts the JSON string or base64 JSON.
- `GOOGLE_OAUTH_CLIENT_ID`: OAuth client ID for uploading to a regular My Drive folder as your Google user.
- `GOOGLE_OAUTH_CLIENT_SECRET`: OAuth client secret for uploading to a regular My Drive folder as your Google user.
- `GOOGLE_OAUTH_REDIRECT_URI`: defaults to `http://localhost:3001/api/google/oauth/callback`.
- `GOOGLE_DRIVE_FOLDER_ID`: default Drive folder ID for finalized PDFs.
- `GOOGLE_DRIVE_AUTO_UPLOAD`: set to `true` to send PDFs to Drive as soon as they finalize.

Without an OpenAI key, uploads still work, but extraction falls back to filename-based demo parsing and will usually require manual review.

Example `.env`:

```bash
APP_USER=admin
APP_PASSWORD=choose-a-private-password
HOST=0.0.0.0
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-5-mini
GM_INITIALS=TC
GOOGLE_APPLICATION_CREDENTIALS=/Users/t.curry/.config/invoice-drive-service-account.json
GOOGLE_OAUTH_CLIENT_ID=your-oauth-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-oauth-client-secret
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/google/oauth/callback
GOOGLE_DRIVE_FOLDER_ID=your-drive-folder-id
GOOGLE_DRIVE_AUTO_UPLOAD=false
```

Restart the server after changing `.env`. Keep `.env` private; it is ignored by git and should not be uploaded or emailed.

## Google Drive Uploads

For regular My Drive folders, use OAuth so uploads count against your own Google Drive storage. Create an OAuth client in Google Cloud, add `http://localhost:3001/api/google/oauth/callback` as an authorized redirect URI, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, restart the app, then use **Controls → Connect Google Drive**.

Service accounts still work for shared drives. Google service accounts can't own files in regular My Drive folders, so a normal folder upload needs OAuth instead.

## Windows PC Access

The easiest setup is to run the app on the Mac and open it from the Windows PC in a browser.

1. Make sure the Mac and Windows PC are on the same office/home network or VPN.
2. On the Mac, start the app:

```bash
cd "/Users/t.curry/Desktop/Invoice App Final"
npm start
```

3. The terminal prints one or more `Windows/LAN access` URLs, such as:

```text
http://100.110.135.94:3001
```

4. Open that URL on the Windows PC in Chrome or Edge.

If Windows cannot connect, check that the Mac firewall allows incoming connections for Node/Terminal and that both computers are on the same reachable network. For access from anywhere, deploy the app to a hosted cloud server instead of running it from the Mac.

## Stamp Placement

Open an invoice from the queue and use the **Stamp Placement** preview in the review panel. The app renders the PDF page and overlays the approval stamp box.

- Drag the stamp box directly on the page preview.
- Use **Bottom left**, **Bottom right**, **Bottom center**, **Top left**, or **Top right** for quick placement.
- Use **Tiny**, **Small**, **Standard**, or **Large** to resize the stamp.
- The advanced coordinates are available only for troubleshooting; normal users should not need them.
