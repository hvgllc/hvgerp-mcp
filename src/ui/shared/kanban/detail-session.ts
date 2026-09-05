export interface DetailSessionToken {
  readonly doctype: string;
  readonly cardId: string;
  readonly generation: number;
}

export interface DetailSaveResult {
  saved: true;
  detailRefreshed: boolean;
}

export function updateDetailDraft(
  draft: Record<string, string>,
  key: string,
  value: string,
  original: string,
  saving: boolean,
): Record<string, string> {
  if (value === original && !saving) {
    const next = { ...draft };
    delete next[key];
    return next;
  }
  return { ...draft, [key]: value };
}

export function sameDetailSession(
  active: DetailSessionToken | null,
  requested: DetailSessionToken,
): boolean {
  return active !== null && active.doctype === requested.doctype &&
    active.cardId === requested.cardId &&
    active.generation === requested.generation;
}

export function createDetailSessionTracker() {
  let generation = 0;
  let active: DetailSessionToken | null = null;
  return {
    open(doctype: string, cardId: string): DetailSessionToken {
      active = { doctype, cardId, generation: ++generation };
      return active;
    },
    close() {
      ++generation;
      active = null;
    },
    isCurrent(session: DetailSessionToken): boolean {
      return sameDetailSession(active, session);
    },
  };
}

// Không hủy request: chỉ ngăn kết quả cũ thay đổi phiên giao diện mới.
export async function settleDetailOperation<T>(options: {
  request: () => Promise<T>;
  isCurrent: () => boolean;
  canApplyResult?: () => boolean;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}): Promise<void> {
  try {
    const result = await options.request();
    if (options.isCurrent() && (options.canApplyResult?.() ?? true)) {
      options.onSuccess(result);
    }
  } catch (error) {
    if (options.isCurrent() && (options.canApplyResult?.() ?? true)) {
      options.onError(error);
    }
  } finally {
    if (options.isCurrent()) options.onSettled();
  }
}
