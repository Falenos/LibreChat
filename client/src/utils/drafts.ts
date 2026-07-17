import debounce from 'lodash/debounce';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';

// [knauf] KK20-227 — keep the shared pending ID tab-scoped across every draft caller.
const draftStorage = (id?: string | null) =>
  id === String(Constants.PENDING_CONVO) ? sessionStorage : localStorage;

export const clearDraft = debounce((id?: string | null, storage: Storage = draftStorage(id)) => {
  storage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${id ?? ''}`);
}, 2500);
// End [knauf]

/** Synchronously removes both text and file drafts for a conversation (or NEW_CONVO fallback) */
export const clearAllDrafts = (conversationId?: string | null) => {
  const key = conversationId || Constants.NEW_CONVO;
  // [knauf] KK20-227 — clear pending drafts from the same tab-scoped store used to save them.
  const storage = draftStorage(String(key));
  // End [knauf]
  storage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${key}`);
  storage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${key}`);
};

export const encodeBase64 = (plainText: string): string => {
  try {
    const textBytes = new TextEncoder().encode(plainText);
    return btoa(String.fromCharCode(...textBytes));
  } catch {
    return '';
  }
};

export const decodeBase64 = (base64String: string): string => {
  try {
    const bytes = atob(base64String);
    const uint8Array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      uint8Array[i] = bytes.charCodeAt(i);
    }
    return new TextDecoder().decode(uint8Array);
  } catch {
    return '';
  }
};

// [knauf] KK20-227 — optional storage keeps existing local drafts while isolating PENDING_CONVO.
export const setDraft = ({
  id,
  value,
  storage = draftStorage(id),
}: {
  id: string;
  value?: string;
  storage?: Storage;
}) => {
  if (value && value.length > 1) {
    storage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${id}`, encodeBase64(value));
    return;
  }
  storage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${id}`);
};

export const getDraft = (id?: string, storage: Storage = draftStorage(id)): string | null =>
  decodeBase64((storage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${id ?? ''}`) ?? '') || '');
// End [knauf]
