type Environment = Record<string, string | undefined>;

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function address(value: string | undefined, key: string, expectedLocalPart: "no-reply" | "support") {
  const result = value?.trim() ?? "";
  if (!result || /[\r\n\0<>]/.test(result) || !ADDRESS.test(result)) throw new Error(`${key} sender is invalid`);
  const [localPart, domain] = result.split("@");
  if (localPart?.toLowerCase() !== expectedLocalPart || !domain) throw new Error(`${key} sender is invalid`);
  return { value: result, domain: domain.toLowerCase() };
}

export function mailSenders(env: Environment) {
  const system = address(env.RESEND_SYSTEM_FROM_EMAIL, "RESEND_SYSTEM_FROM_EMAIL", "no-reply");
  const support = address(env.RESEND_SUPPORT_FROM_EMAIL, "RESEND_SUPPORT_FROM_EMAIL", "support");
  if (system.domain !== support.domain) throw new Error("Resend system and support sender domains must match");
  return { system: system.value, support: support.value, domain: system.domain };
}
