/**
 * Reads the Firebase web-app settings from the build environment
 * (VITE_FIREBASE_* variables; see .env.example and docs/FIREBASE_SETUP.md).
 *
 * These are public client settings, not secrets: every visitor's browser
 * receives them. What protects the game is database.rules.json plus
 * Anonymous Authentication. Never put service-account keys or Admin SDK
 * credentials in these variables.
 */

export interface FirebaseWebConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly databaseURL: string;
  readonly projectId: string;
  readonly appId: string;
}

export interface EmulatorConfig {
  readonly host: string;
  readonly databasePort: number;
  readonly authPort: number;
}

export type FirebaseConfigStatus =
  | { readonly kind: 'ready'; readonly config: FirebaseWebConfig; readonly emulator: EmulatorConfig | null }
  | { readonly kind: 'missing'; readonly missing: readonly string[] }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] };

const FIELDS: readonly [keyof FirebaseWebConfig, string][] = [
  ['apiKey', 'VITE_FIREBASE_API_KEY'],
  ['authDomain', 'VITE_FIREBASE_AUTH_DOMAIN'],
  ['databaseURL', 'VITE_FIREBASE_DATABASE_URL'],
  ['projectId', 'VITE_FIREBASE_PROJECT_ID'],
  ['appId', 'VITE_FIREBASE_APP_ID'],
];

export type Env = Readonly<Record<string, string | boolean | undefined>>;

export function readFirebaseConfig(env: Env): FirebaseConfigStatus {
  const get = (name: string) => {
    const v = env[name];
    return typeof v === 'string' ? v.trim() : '';
  };
  const missing = FIELDS.filter(([, name]) => !get(name)).map(([, name]) => name);
  if (missing.length > 0) return { kind: 'missing', missing };
  const config = Object.fromEntries(FIELDS.map(([key, name]) => [key, get(name)])) as unknown as FirebaseWebConfig;
  const problems: string[] = [];
  if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)\/?$/.test(config.databaseURL)) {
    problems.push('VITE_FIREBASE_DATABASE_URL must look like https://<project>-default-rtdb.<region>.firebasedatabase.app');
  }
  if (!/^[a-z0-9-]{4,40}$/.test(config.projectId)) problems.push('VITE_FIREBASE_PROJECT_ID does not look like a Firebase project id');
  if (!/^1:\d+:web:\w+$/.test(config.appId)) problems.push('VITE_FIREBASE_APP_ID should look like 1:1234567890:web:abc123');
  if (/PRIVATE KEY|service_account|"type"\s*:/.test(Object.values(config).join(' '))) {
    problems.push('These look like server credentials. Only the public web-app config belongs here.');
  }
  if (problems.length) return { kind: 'invalid', problems };

  let emulator: EmulatorConfig | null = null;
  const emu = get('VITE_FIREBASE_EMULATOR');
  if (emu) {
    const m = /^([\w.-]+):(\d+):(\d+)$/.exec(emu);
    // Emulators only ever for demo- projects, which cannot reach real Firebase data.
    if (!m || !config.projectId.startsWith('demo-')) {
      return { kind: 'invalid', problems: ['VITE_FIREBASE_EMULATOR is set but malformed, or the project is not a demo- project'] };
    }
    emulator = { host: m[1], databasePort: Number(m[2]), authPort: Number(m[3]) };
  }
  return { kind: 'ready', config, emulator };
}
