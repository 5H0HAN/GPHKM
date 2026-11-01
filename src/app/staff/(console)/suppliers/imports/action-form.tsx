"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import type { ImportActionState } from "./action-state";

type ImportAction = (state: ImportActionState, form: FormData) => Promise<ImportActionState>;

export function ImportActionForm({ action, children, className, id, noValidate }: {
  action: ImportAction;
  children: ReactNode;
  className?: string;
  id?: string;
  noValidate?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  useEffect(() => {
    if (state?.redirectTo) window.location.assign(state.redirectTo);
  }, [state?.redirectTo]);

  return <form action={formAction} className={className} id={id} noValidate={noValidate} aria-busy={pending || undefined}>
    {children}
    {pending && <p role="status" aria-live="polite">Saving…</p>}
  </form>;
}
