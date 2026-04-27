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

Without an OpenAI key, uploads still work, but extraction falls back to filename-based demo parsing and will usually require manual review.

Example `.env`:

```bash
APP_USER=admin
APP_PASSWORD=choose-a-private-password
HOST=0.0.0.0
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-5-mini
GM_INITIALS=TC
```

Restart the server after changing `.env`. Keep `.env` private; it is ignored by git and should not be uploaded or emailed.

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
- Use **Small**, **Standard**, or **Large** to resize the stamp.
- The advanced coordinates are available only for troubleshooting; normal users should not need them.
