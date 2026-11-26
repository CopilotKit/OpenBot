# OpenBot Mobile

**Before you change a request this app makes, or the client generated from the API spec
(`src/api/generated`), read [docs/api-and-migrations.md](../docs/api-and-migrations.md). Not
optional.**

This app is not a clone of the desktop app. For launch it focuses on the core Bot experience: Bot
screens, conversations and routines. It is styled with Uniwind and HeroUI Native, and it draws only
with the color scheme every OpenBot app shares: its colors come from `src/scheme.ts`, written from
`tokens/src/scheme.ts` by `bun run tokens:generate`, never a value of its own. Before you add
a screen or a feature, read [docs/app-guidelines.md](../docs/app-guidelines.md).

For now, a build that names the web app (`EXPO_PUBLIC_WEB_URL`) shows it in a web view and keeps
native only the launch, push notifications and the way out of the page (`src/web/`). Before you
change `src/web/`, read "The web view" in [README.md](README.md): the page holds the sign-in, and
nothing is sold in the app.

Released versions of OpenBot Mobile stay on people's phones for months. The server serves every app released in the
last 12 months, and this app works against any server released in the last 12 months. So this app
is a tolerant reader: it ignores a field it doesn't know, reads an enum value it doesn't know as
"other" and never sends it back, and shows a feature only when the server's `deployment` answer
offers it. `tests/tolerant-reader.test.ts` and `tests/unknown-statuses.test.ts` hold it to that.

The components every screen draws with are in `src/components` (see "The phone's components" in
[docs/app-guidelines.md](../docs/app-guidelines.md)); the development build shows them all at
`/gallery`. Import an icon from `src/icons.ts` and a HeroUI Native component from its own path
(`heroui-native/button`): either package's index pulls the whole library into the app.
`src/uniwind-types.d.ts` is written by Uniwind when Metro starts; after a change to
`global.css`'s themes, run `npx uniwind generate-artifacts --css ./global.css --dts
./src/uniwind-types.d.ts`.

How to run the app, the checks CI makes, and how a build is started: [README.md](README.md). Add a
dependency with `npx expo install <name>` and commit `package-lock.json`.

Never edit `src/api/generated` by hand. Change the spec under `api/openapi/` and run
`bun run api:generate` from the repository root.
