import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

const driveScopes = ["https://www.googleapis.com/auth/drive.file"];
const oauthTokenPath = path.join(process.cwd(), "data", "google-drive-oauth-token.json");

type DriveUploadResult = {
  id: string;
  name: string;
  webViewLink?: string | null;
};

type ServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  [key: string]: string | undefined;
};

function credentialsFromJson(raw: string): ServiceAccountCredentials {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(jsonText.replace(/\\n/g, "\n")) as ServiceAccountCredentials;
}

function configuredCredentialsJson(): string {
  return process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
}

function oauthRedirectUri(): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/google/oauth/callback`;
}

function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, oauthRedirectUri());
}

export function normalizeGoogleDriveFolderId(value: string | undefined): string {
  const trimmed = String(value || "").trim();
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  return trimmed;
}

export function hasGoogleDriveCredentials(): boolean {
  return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || configuredCredentialsJson());
}

export function hasGoogleDriveOAuthCredentials(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function hasGoogleDriveOAuthToken(): boolean {
  return existsSync(oauthTokenPath);
}

export function googleDriveOAuthAuthUrl(): string {
  if (!hasGoogleDriveOAuthCredentials()) return "";
  return createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: driveScopes
  });
}

export async function saveGoogleDriveOAuthCode(code: string): Promise<void> {
  if (!hasGoogleDriveOAuthCredentials()) {
    throw new Error("Google OAuth credentials are not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.");
  }

  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  mkdirSync(path.dirname(oauthTokenPath), { recursive: true });
  writeFileSync(oauthTokenPath, JSON.stringify(tokens, null, 2));
}

export function googleDriveServiceAccountEmail(): string {
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const credentials = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")) as ServiceAccountCredentials;
      return credentials.client_email || "";
    }

    const rawJson = configuredCredentialsJson();
    return rawJson ? credentialsFromJson(rawJson).client_email || "" : "";
  } catch {
    return "";
  }
}

async function googleAuth() {
  if (hasGoogleDriveOAuthCredentials() && hasGoogleDriveOAuthToken()) {
    const client = createOAuthClient();
    const credentials = JSON.parse(readFileSync(oauthTokenPath, "utf8")) as Credentials;
    client.setCredentials(credentials);
    return client;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: driveScopes
    });
  }

  const rawJson = configuredCredentialsJson();
  if (rawJson) {
    return new google.auth.GoogleAuth({
      credentials: credentialsFromJson(rawJson),
      scopes: driveScopes
    });
  }

  throw new Error(
    "Google Drive credentials are not configured. Connect Google Drive with OAuth or set GOOGLE_APPLICATION_CREDENTIALS."
  );
}

export async function uploadPdfToGoogleDrive(input: {
  sourcePath: string;
  fileName: string;
  folderId: string;
}): Promise<DriveUploadResult> {
  const folderId = normalizeGoogleDriveFolderId(input.folderId);
  if (!folderId) throw new Error("Google Drive folder ID is not configured.");

  const drive = google.drive({ version: "v3", auth: await googleAuth() });
  const response = await drive.files.create({
    requestBody: {
      name: input.fileName,
      parents: [folderId],
      mimeType: "application/pdf"
    },
    media: {
      mimeType: "application/pdf",
      body: createReadStream(input.sourcePath)
    },
    fields: "id,name,webViewLink",
    supportsAllDrives: true
  });

  if (!response.data.id || !response.data.name) {
    throw new Error("Google Drive did not return an uploaded file ID.");
  }

  return {
    id: response.data.id,
    name: response.data.name,
    webViewLink: response.data.webViewLink
  };
}
