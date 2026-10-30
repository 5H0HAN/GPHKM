export type ResendAttemptIdentity = Readonly<{
  id: string;
  provider: string | null;
  type: string;
  providerReference: string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function correlateResendAttempt(input: {
  emailId: string;
  taggedAttemptId?: string | null;
  taggedAttempt?: ResendAttemptIdentity | null;
  referenceAttempt?: ResendAttemptIdentity | null;
}): { attemptId: string | null; conflict: boolean } {
  const tagPresent = input.taggedAttemptId !== undefined && input.taggedAttemptId !== null;
  if (tagPresent) {
    const attempt = input.taggedAttempt;
    if (!UUID.test(input.taggedAttemptId!) || !attempt || attempt.id !== input.taggedAttemptId
      || attempt.provider !== "RESEND" || attempt.type !== "SEND"
      || (attempt.providerReference !== null && attempt.providerReference !== input.emailId)
      || (input.referenceAttempt && input.referenceAttempt.id !== attempt.id)) {
      return { attemptId: null, conflict: true };
    }
    return { attemptId: attempt.id, conflict: false };
  }
  const attempt = input.referenceAttempt;
  if (!attempt) return { attemptId: null, conflict: false };
  if (attempt.provider !== "RESEND" || attempt.type !== "SEND" || attempt.providerReference !== input.emailId) {
    return { attemptId: null, conflict: true };
  }
  return { attemptId: attempt.id, conflict: false };
}
