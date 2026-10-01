import { create } from "zustand";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

interface PendingConfirm {
  input: ConfirmDialogInput;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogState {
  pending: PendingConfirm | null;
  request: (input: ConfirmDialogInput) => Promise<boolean>;
  answer: (confirmed: boolean) => void;
}

// Backs the browser confirm dialog. The browser's own window.confirm ignores the
// app theme and some browsers draw it unreadable, so web renders ConfirmDialogHost.
export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pending: null,
  request: (input) =>
    new Promise<boolean>((resolve) => {
      // A newer request supersedes one still on screen; the older caller sees a cancel.
      get().pending?.resolve(false);
      set({ pending: { input, resolve } });
    }),
  answer: (confirmed) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));
