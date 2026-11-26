import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// CRITICAL: Pass firestoreDatabaseId explicitly to connect to the provisioned Enterprise database
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

// Persist login session across browser restarts until explicit sign-out or password/token revocation
setPersistence(auth, browserLocalPersistence).catch(() => {});

const REVOCATION_ERROR_CODES = new Set([
  'auth/user-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-user-token',
  'auth/user-disabled',
  'auth/user-not-found',
  'auth/requires-recent-login',
  'auth/token-expired',
]);

let lastSessionCheckAt = 0;

/**
 * Verifies the active Firebase/Google session against Google Identity servers.
 * Leaves the user signed in across restarts & temporary offline states,
 * and automatically signs out if their Google/account password or tokens were revoked.
 */
export async function verifyActiveAuthSession(
  user: User | null,
  options?: { force?: boolean }
): Promise<{ valid: boolean; revoked: boolean }> {
  if (!user) return { valid: false, revoked: false };

  const now = Date.now();
  if (!options?.force && now - lastSessionCheckAt < 30_000) {
    return { valid: true, revoked: false };
  }
  lastSessionCheckAt = now;

  try {
    await user.getIdToken(true);
    await user.reload();
    return { valid: true, revoked: false };
  } catch (err: unknown) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    const msg = err instanceof Error ? err.message : String(err || '');

    const isRevoked =
      REVOCATION_ERROR_CODES.has(code) ||
      /TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|CREDENTIAL_TOO_OLD|USER_NOT_FOUND/i.test(
        msg
      );

    if (isRevoked) {
      await signOut(auth).catch(() => {});
      return { valid: false, revoked: true };
    }

    // Transient offline/network error should not unexpectedly log the user out
    return { valid: true, revoked: false };
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testConnection();
