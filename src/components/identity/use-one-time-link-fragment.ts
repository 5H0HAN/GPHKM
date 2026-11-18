"use client";

import { useEffect, useState } from "react";

export function useOneTimeLinkFragment() {
  const [fragment, setFragment] = useState<URLSearchParams | null>(null);
  useEffect(() => {
    const captured = new URLSearchParams(window.location.hash.slice(1));
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      if (window.location.hash) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
      setFragment(captured);
    });
    return () => { mounted = false; };
  }, []);
  return [fragment, () => setFragment(new URLSearchParams())] as const;
}
