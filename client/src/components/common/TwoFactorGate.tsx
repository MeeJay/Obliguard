import { useEffect, useRef, useState } from 'react';
import { TwoFactorPromptModal } from './TwoFactorPromptModal';
import { setTwoFactorListener, TWO_FACTOR_CANCELLED, type StepUpMethod } from '@/utils/twoFactorGate';

// Mount this ONCE in the signed-in app shell (AppLayout). It registers the
// listener the axios response interceptor calls when a sensitive action
// answers 401 TWO_FACTOR_REQUIRED: the prompt is displayed, confirms the
// session, and the pending promise resolves so axios replays the request.
// Ported from Obliance client/src/components/common/TwoFactorGate.tsx.
//
// No props — this component is intentionally a singleton.

interface Pending {
  action: string;
  methods: StepUpMethod[];
  ttlSeconds?: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

export function TwoFactorGate() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  useEffect(() => {
    setTwoFactorListener((p) => {
      // A second prompt while one is open (should not happen: the interceptor
      // shares one prompt) cancels the older one.
      pendingRef.current?.reject(new Error(TWO_FACTOR_CANCELLED));
      pendingRef.current = p;
      setPending(p);
    });
    return () => {
      setTwoFactorListener(null);
      // Shell unmounted (sign-out): nothing will answer the pending prompt.
      pendingRef.current?.reject(new Error(TWO_FACTOR_CANCELLED));
      pendingRef.current = null;
    };
  }, []);

  const close = () => {
    pendingRef.current = null;
    setPending(null);
  };

  if (!pending) return null;

  return (
    <TwoFactorPromptModal
      // A new prompt starts from a clean form.
      key={`${pending.action}:${pending.methods.join(',')}`}
      action={pending.action}
      methods={pending.methods}
      ttlSeconds={pending.ttlSeconds}
      onCancel={() => {
        pending.reject(new Error(TWO_FACTOR_CANCELLED));
        close();
      }}
      onConfirmed={() => {
        pending.resolve();
        close();
      }}
    />
  );
}
