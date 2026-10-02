import { create } from 'zustand';

export type SocketStatus = 'connected' | 'disconnected' | 'reconnecting';

interface SocketState {
  status: SocketStatus;
  /**
   * Incremented every time connectSocket() builds a NEW socket instance
   * (login, tenant switch, rebuild after a server disconnect). Effects that
   * bind listeners on getSocket() depend on it, so they re-bind to the new
   * instance instead of staying attached to the dead one.
   */
  generation: number;
  setStatus: (status: SocketStatus) => void;
  bumpGeneration: () => void;
}

export const useSocketStore = create<SocketState>((set) => ({
  status: 'disconnected',
  generation: 0,
  setStatus: (status) => set({ status }),
  bumpGeneration: () => set((s) => ({ generation: s.generation + 1 })),
}));
