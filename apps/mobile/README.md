# hive for Android

Expo-managed React Native, with plain screen navigation. Android is a conversation, search, approval and activity client; it never registers an executor device or runs an Agent Runtime.

## Build and run

From the repository root:

```sh
bun install
export ANDROID_HOME=/Users/masatomo.kusaka/Library/Android/sdk
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export HIVE_API_URL=https://api.example.com
bun run --cwd apps/mobile android
```

Requires Android SDK platform/build-tools 36, NDK 27.1.12297006, CMake 3.22.1, and an emulator or USB Android device. Gradle also installs build-tools 35.0.0 when needed; accept the SDK licenses first. `emulator -list-avds` lists existing AVDs. Expo generates the ignored `android/` directory; do not maintain native files by hand. Rebuild with `bun run --cwd apps/mobile expo prebuild --platform android --clean --no-install` after changing the API hostname, build flags or Firebase configuration.

Expo is pinned to 57.0.26, React Native to 0.86.3 and React to 19.2.3. The repository's seven-day minimum release age blocked Expo 57.0.27, expo-notifications 57.0.22 and expo-constants 57.0.21; the preceding allowed SDK 57 versions are pinned instead.

## Access login and App Links

Welcome uses the same sign-in copy as desktop. Enter the API origin, sign in through the system browser, then choose a workspace from `/v1/me` (or create one). No PC registration step is shown.

`@hive/access` contains RFC 9728 resource discovery, OAuth discovery/DCR, PKCE/state validation, token exchange and refresh. Expo Crypto supplies native random values and the SHA-256 challenge; no `expo-auth-session` or Node loopback listener is used on Android. Grants are kept in `expo-secure-store`, refreshed with a 30-second margin, and removed on sign out. Revoked refresh grants require sign-in again.

The production redirect is `https://hive-api.<subdomain>.workers.dev/mobile/callback`; no custom domain is required. Build with `HIVE_API_URL=https://hive-api.<subdomain>.workers.dev` (Terraform's `api_url` output); the Android manifest includes a verified HTTPS App Link for that callback host. Configure Worker vars `MOBILE_APP_PACKAGE=com.hive.mobile` and `MOBILE_APP_SHA256` with the signing certificate's colon-delimited SHA-256 fingerprint (comma-separated for multiple certificates). The public `/.well-known/assetlinks.json` route publishes the association. If a browser opens the callback instead of handing it directly to Android, the no-store page's **Continue to Hive** link uses an Android intent to the same request-derived HTTPS URL and package.

Android's association fetch must not be intercepted by Access; see [infra setup](../../infra/README.md#android-app-links-and-fcm-mobile-01). DCR must permit the exact HTTPS redirect. Real Access login, App Link verification and refresh remain **G-03 not executed** until tested on a real tenant/device.

Development-only fallback: build with `HIVE_MOBILE_DEV_SCHEME=1` to register `hive://callback`; the app uses that redirect only in development. `MOBILE_DEV_SCHEME=true` enables the callback page's custom-scheme handoff on a local/dev Worker. Do not enable either flag in production or assume Access accepts a custom scheme.

## Local dev-token check

Run an isolated local Worker on port 8807 after applying migrations and generating `.dev.vars` as described in the API Worker README. Use a scratch `XDG_CONFIG_HOME` for CLI workspace/channel/bot creation and a PC executor, not the real executor service.

```sh
HIVE_API_URL=http://10.0.2.2:8807 HIVE_MOBILE_DEV_SCHEME=1 \
  bun run --cwd apps/mobile android --port 8087
```

In Welcome, enter `http://10.0.2.2:8807` and paste `HIVE_ACCESS_JWT` into the masked development field. It is stored in SecureStore, not the app bundle, and bypasses browser sign-in only in a development build. Never print or commit the token. On a USB device, use `adb reverse tcp:8807 tcp:8807` and `http://localhost:8807` instead.

Choose the workspace, open `#dev`, type `@`, select coder, and send `reply with exactly: mobile ok`. Background the app with Android Home, then run `executor run --once --provider claude` on the PC using the same scratch CLI profile. Return to the app; its foreground HTTP pull must show the cloud reply without relying on a background WebSocket. To check approvals, configure the Bot with `Bash=ask`, request a Bash action, and open Approvals while its Run waits.

## Sync, screens and push

- Chats lists channels and DMs with previews, Starred first, server-side groups and hidden items omitted. Bot rows open/create DMs.
- Conversations use the safe Markdown data parser from `@hive/ui-text` shared with desktop. `@` suggestions insert `<@bot:ID>` tokens; replies open a separate thread screen. Unsent drafts remain on failed sends. The composer, suggestions and navigation remain above the Android keyboard.
- Approvals shows the action, redacted arguments, location and expiry. Allow/Deny sends `approval.resolve`; expiry, generation and one-use validity are checked by the server when answering.
- Activity shows Job states and cancellation requests, with read-only Job/Task/Run details. Search shows the projection watermark. Settings offers workspace selection and confirmed sign-out.
- `@hive/sync` is shared with desktop: head-cursor bootstrap, paged deltas and 410 re-bootstrap. It awaits list refresh before advancing the cursor. Foreground always pulls HTTP; background closes the authenticated WebSocket. Foreground reconciliation also runs every 15 seconds.

For background notifications, supply the Firebase Android `google-services.json` using `HIVE_GOOGLE_SERVICES_FILE` before prebuild, grant notification permission, and configure Worker secret `FCM_SERVICE_ACCOUNT_JSON`. The app registers the native FCM token per user/app instance at `POST /v1/devices/mobile`, updates rotated tokens, and unregisters on sign-out. An offline unregister failure does not retain local credentials; re-registering a token transfers it away from the previous account.

FCM HTTP v1 data is exactly `{kind: "approval" | "mention" | "job", id}`; the visible notification is generic. Approval requests use the approval ID. `<@user:USER_ID>` channel mentions and Bot replies in DMs/DM threads use the conversation ID. On tap the app pulls HTTP, resolves the authorized target at `/v1/mobile/targets/:kind/:id`, and opens it, switching workspaces when necessary. Push never updates cached state or carries approval credentials. Without Firebase credentials, Settings reports FCM unavailable; all foreground features work normally.

Root `bun run typecheck`, `lint`, `format:check` and `test` include mobile and the shared packages. Vitest covers portable models, sync, Markdown, OAuth and Worker push behavior; `jest-expo` and RN component tests are not added. The actual native UI must be checked in the emulator. Real FCM delivery, verified App Links and real Access remain external verification limits.
