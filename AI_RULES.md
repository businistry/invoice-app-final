# AI Rules

## Tech stack
- React 19 and TypeScript power the browser interface; `src/main.tsx` mounts `src/App.tsx`.
- Vite 7 builds and serves the frontend, with `/api` requests proxied to port 3001 during development.
- Node.js, Express 5, and TypeScript provide the existing backend in `server/`; `tsx` runs server code.
- The current interface uses `src/styles.css` and Lucide React icons; Tailwind CSS and shadcn/ui are preferred for new UI work but are not currently listed in the package manifest.
- Native browser `fetch` and `FormData` handle JSON API requests and multipart uploads through `src/api.ts`.
- `pdfjs-dist` renders browser PDF previews; `pdf-lib` creates approval stamps in finalized PDFs on the server.
- The OpenAI SDK supports server-side invoice extraction and AI GL-code suggestions; `googleapis` handles Google Drive authentication and uploads.
- `csv-parse` and `read-excel-file` parse GL-code imports; `multer` handles uploads and `nanoid` generates identifiers.
- Local JSON and filesystem storage in `data/` persist records and PDFs through `server/storage.ts`; no external database or ORM is currently used.
- Node's test runner with `tsx` runs TypeScript tests; Playwright is available for browser testing, and TypeScript checks are part of the production build.

## Code organization and UI
- Keep browser source in `src/`, new reusable components in `src/components/`, and new page components in `src/pages/`. Wire new UI into the existing `src/App.tsx` so it is visible.
- Keep backend logic in the existing `server/` modules. Extend Express rather than introducing a second server framework.
- Use React hooks for local state and effects. Do not add a global state library for ordinary component state.
- Prefer Tailwind CSS for new styling and shadcn/ui for standard controls when those dependencies are configured. Do not assume they are installed or migrate existing CSS merely to make an unrelated change. Do not edit generated shadcn/ui primitives; compose wrappers instead.
- Use `lucide-react` for icons rather than adding another icon library.
- The current app switches views inside `src/App.tsx`. If URL-based routing is needed, use React Router and keep route declarations in `src/App.tsx`; do not add routing solely for an unrelated feature.

## Library responsibilities
- Centralize browser API calls and response errors in `src/api.ts`, using native `fetch`; use `FormData` for files. Do not add Axios for equivalent requests.
- Use `pdfjs-dist` for preview rendering and preserve its Vite worker configuration. Use `pdf-lib` for server-side PDF edits and stamping, not for browser preview rendering.
- Use the `openai` SDK only on the server for extraction and AI suggestions. Keep existing non-AI/manual-review paths usable when AI credentials are absent.
- Use `googleapis` in `server/googleDrive.ts` for Drive operations, preserving the existing OAuth and service-account flows.
- Use `csv-parse/sync` for CSV and `read-excel-file/node` for Excel imports in `server/glImport.ts`; do not parse CSV by splitting on commas.
- Use `multer` for multipart upload handling and `nanoid` for new record IDs. Validate uploaded files and user-controlled paths on the server.
- Use Zod, already listed as a dependency, when adding structured runtime validation at API or external-service boundaries. TypeScript types alone do not validate external data.
- Reuse `server/storage.ts` for persistence and the existing frontend/backend types in `src/types.ts` and `server/types.ts`. Keep API contracts consistent; do not introduce an ORM or database migration without a requirement.

## Security and change discipline
- Load server configuration with the existing `dotenv` setup. Never expose OpenAI keys, Google credentials, OAuth tokens, or app passwords through client code, public assets, or Vite client environment variables.
- Preserve existing authentication and apply it to new protected endpoints. Validate input at trust boundaries and keep invoice files within the intended storage directories.
- Make focused changes, reuse existing modules, and avoid new dependencies when an installed library or native API meets the need.
- Verify code changes with TypeScript checks and relevant tests. Verify production-path or build-configuration changes with the production build; documentation-only changes do not require a build.
