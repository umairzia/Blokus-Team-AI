/**
 * Backend implemented with the Firebase JS SDK (Realtime Database and
 * Anonymous Authentication). The SDK keeps the anonymous account in the
 * browser, so after a refresh the same uid (and therefore the same seat)
 * comes back.
 */

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  goOffline,
  goOnline,
  onDisconnect,
  onValue,
  ref,
  serverTimestamp,
  set,
  update,
  type Database,
} from 'firebase/database';
import { clean, type Backend, type Unsubscribe } from './backend';
import type { EmulatorConfig, FirebaseWebConfig } from './firebase-config';

export class FirebaseBackend implements Backend {
  readonly kind = 'firebase' as const;
  readonly TIMESTAMP = serverTimestamp();
  readonly uid: string;
  private readonly app: FirebaseApp;
  private readonly db: Database;

  private constructor(app: FirebaseApp, db: Database, uid: string) {
    this.app = app;
    this.db = db;
    this.uid = uid;
  }

  /** Connects and signs in anonymously. Rejects if sign-in fails. */
  static async connect(config: FirebaseWebConfig, emulator: EmulatorConfig | null, appName?: string): Promise<FirebaseBackend> {
    const app = initializeApp(config, appName);
    const auth = getAuth(app);
    const db = getDatabase(app);
    if (emulator) {
      connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
      connectDatabaseEmulator(db, emulator.host, emulator.databasePort);
    }
    const uid = await signIn(auth);
    return new FirebaseBackend(app, db, uid);
  }

  onConnection(cb: (online: boolean) => void): Unsubscribe {
    return onValue(ref(this.db, '.info/connected'), (snap) => cb(snap.val() === true));
  }

  watch(path: string, onValueCb: (value: unknown) => void, onError?: (err: Error) => void): Unsubscribe {
    return onValue(
      ref(this.db, path),
      (snap) => onValueCb(snap.val()),
      (err) => onError?.(err),
    );
  }

  async get(path: string): Promise<unknown> {
    return (await get(ref(this.db, path))).val();
  }

  update(paths: Record<string, unknown>): Promise<void> {
    return update(ref(this.db), clean(paths));
  }

  presence(path: string): Unsubscribe {
    const node = ref(this.db, path);
    const stop = onValue(ref(this.db, '.info/connected'), (snap) => {
      if (snap.val() !== true) return;
      onDisconnect(node)
        .set({ on: false, at: serverTimestamp() })
        .then(() => set(node, { on: true, at: serverTimestamp() }))
        .catch(() => {
          /* not in the room any more */
        });
    });
    return () => {
      stop();
      onDisconnect(node)
        .cancel()
        .catch(() => {});
      set(node, { on: false, at: serverTimestamp() }).catch(() => {});
    };
  }

  /** Drops or restores the connection, as a network failure would (used by tests). */
  setNetworkEnabled(on: boolean): void {
    if (on) goOnline(this.db);
    else goOffline(this.db);
  }

  dispose(): void {
    void deleteApp(this.app).catch(() => {});
  }
}

function signIn(auth: Auth): Promise<string> {
  return new Promise((resolve, reject) => {
    let asked = false;
    const stop = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          stop();
          resolve(user.uid);
        } else if (!asked) {
          asked = true;
          signInAnonymously(auth).catch((err: unknown) => {
            stop();
            reject(err);
          });
        }
      },
      (err) => reject(err),
    );
  });
}
