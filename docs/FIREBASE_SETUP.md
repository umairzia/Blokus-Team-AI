# Setting up Firebase for online play

Online rooms need a free Firebase project of your own: **Anonymous
Authentication** (so each browser gets an id without anyone creating an
account) and a **Realtime Database** (where the room lives). Everything fits in
the free **Spark** plan; no credit card is needed. It takes about 10 minutes.

Use a **new** project for this game. Do not reuse the Sequence-game project.

Until these steps are done, the site still works: it shows "Online play is not
set up" and offers offline practice.

## 1. Create the project

1. Open <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project** (or **Add project**), name it for example
   `blokus-team-ai`, and continue. Google Analytics is not needed; you can
   switch it off.

## 2. Turn on anonymous sign-in

1. In the left menu open **Security › Authentication** (older consoles:
   **Build › Authentication**) and click **Get started**.
2. On the **Sign-in method** tab choose **Anonymous**, switch it on and
   **Save**.

Players never see this. Each browser receives an anonymous id that the
browser keeps, which is how the game recognises a player after a refresh.

## 3. Create the Realtime Database

1. Open **Databases & Storage › Realtime Database** (older consoles: **Build ›
   Realtime Database**) and click **Create Database**.
2. Pick the location closest to both players, choose **Start in locked mode**,
   and click **Enable**. (If creation fails, try another location; Belgium
   `europe-west1` usually works.)
3. Note the database address shown at the top of the **Data** tab, for example
   `https://blokus-team-ai-default-rtdb.europe-west1.firebasedatabase.app`.

## 4. Publish the security rules

1. In Realtime Database open the **Rules** tab.
2. Delete what is there, paste the whole of
   [`database.rules.json`](../database.rules.json) and click **Publish**.

Without this step every write is refused and rooms cannot be created. If you
use the [Firebase CLI](https://firebase.google.com/docs/cli) you can instead
run, from the repository folder:

```bash
npx firebase deploy --only database --project <your-project-id>
```

What the rules allow is summarised in the README (section *Security*), and
every allowed and refused case is tested against the official emulator in
`tests/firebase/rules.test.ts`.

## 5. Register a web app and copy its settings

1. Open **Settings › General** (the gear next to **Project Overview**, then
   **Project settings**) and scroll to **Your apps**.
2. Click the web icon **`</>`**, give it a nickname (e.g. `Blokus Team AI`),
   leave Firebase Hosting unticked, and click **Register app**.
3. Firebase shows a `firebaseConfig` object. You need five of its values:

| Firebase config field | Variable name |
| --- | --- |
| `apiKey` | `VITE_FIREBASE_API_KEY` |
| `authDomain` | `VITE_FIREBASE_AUTH_DOMAIN` |
| `databaseURL` | `VITE_FIREBASE_DATABASE_URL` |
| `projectId` | `VITE_FIREBASE_PROJECT_ID` |
| `appId` | `VITE_FIREBASE_APP_ID` |

If `databaseURL` is missing from the snippet, use the database address from
step 3. `storageBucket`, `messagingSenderId` and `measurementId` are not used.

## 6. Give the settings to the live site (GitHub)

The site is built by GitHub Actions, which reads these values from
**repository variables**:

1. On GitHub open the repository, then **Settings › Secrets and variables ›
   Actions**, and select the **Variables** tab.
2. Click **New repository variable** five times and add the five names from
   the table above with your values (no quotes).
3. Open the **Actions** tab, choose the **CI and deploy** workflow and click
   **Run workflow** (or push any commit to `main`).

When the run is green, reload the site: the home page offers **Create room**
and the top bar says **Not connected** (it connects when you create or join a
room) instead of "Online play not set up".

## 7. Recommended: restrict the API key to your site

1. Open <https://console.cloud.google.com/apis/credentials> and pick the same
   project.
2. Open **Browser key (auto created by Firebase)**.
3. Under **Application restrictions** choose **Websites** and add
   `https://umairzia.github.io/*`, plus `http://localhost:5173/*` and
   `http://127.0.0.1:5173/*` if you run the game locally against the real
   project. Save.

Optionally, in **Authentication › Settings › Authorized domains**, make sure
`umairzia.github.io` is listed (anonymous sign-in does not require it, but it
does no harm).

## Public configuration versus secrets

The five values above are **public client configuration**: every visitor's
browser downloads them, and they only tell the Firebase SDK which project to
talk to. That is why they are repository *variables*, not secrets, and why it
is fine for them to appear in the built JavaScript.

What protects the game is:

- the database rules (step 4): who may read a room, who may write what;
- anonymous authentication (step 2): every request carries a verified id;
- the API-key restriction (step 7): other websites cannot use your key.

**Never** put a service-account key, an Admin SDK credential, a private key
or any `.json` key file into the repository, into GitHub variables used by
the build, or into the site. The game does not need any of them, and the build
check (`npm run check:dist`) fails if something that looks like one ends up in
the published files.

## Local development

Copy `.env.example` to `.env.local` (git ignores it) and fill in the same
five values, then:

```bash
npm install
npm run dev        # http://127.0.0.1:5173/Blokus-Team-AI/
```

Without `.env.local` the local site behaves like an unconfigured deployment:
offline practice only.

## Local emulators (no real Firebase needed)

The automated tests never touch a real project. They start Google's official
Auth and Realtime Database emulators with the demo project id `demo-blokus`
(demo projects cannot reach real Firebase resources). This needs Java 11 or
newer; the emulator is downloaded once into `~/.cache/firebase/emulators`.

```bash
npm run test:firebase       # database rules + the Firebase SDK, against the emulators
npm run test:e2e:emulator   # two browsers playing through the emulators
```

To click around against the emulators yourself:

```bash
npm run build:emulator
npx firebase emulators:start --only auth,database --project demo-blokus
# in another terminal:
npx vite preview --outDir dist-emulator --port 4174
# open http://127.0.0.1:4174/Blokus-Team-AI/ in two different browsers
```

`firebase.json` (used by `emulators:start` and `firebase deploy`) loads
`database.rules.json` automatically. The test scripts use `firebase.test.json`
instead and upload the rules themselves, so they always test the current file.

## Free plan limits and cleanup

The Spark plan allows 100 simultaneous connections, 1 GB stored and 10 GB
downloaded per month. A room is a few kilobytes and a whole game well under
1 MB of traffic. When the host presses **Leave** the room is deleted. Rooms
that are simply abandoned stay in the database; you can delete them in the
console (**Realtime Database › Data**) at any time. Old anonymous accounts can
be cleaned up automatically under **Authentication › Settings › User account
management** (automatic clean-up of anonymous accounts) if you enable it.

## Troubleshooting

| Message on the site | Fix |
| --- | --- |
| "Online play is not set up on this copy of the game yet" | The five repository variables are missing or misspelt (step 6), or the workflow has not run since you added them. The message lists what is missing. |
| "Anonymous sign-in is turned off in the Firebase project" | Step 2. |
| "The database refused the request…" when creating a room | The rules are not published (step 4). |
| "Firebase rejected the API key" | Check `VITE_FIREBASE_API_KEY`; if you restricted the key (step 7), make sure the site's address is in the list. |
| "Cannot reach the game server" | Check the internet connection and `VITE_FIREBASE_DATABASE_URL`. |
