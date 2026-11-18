export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { localAuthEnabled, localStaffMfaDisabled, requiredMfaProofDatabaseUrl } = await import("./src/server/auth/policy");
  localAuthEnabled(process.env);
  const staffMfaBypassed = localStaffMfaDisabled(process.env);
  if (!staffMfaBypassed) requiredMfaProofDatabaseUrl(process.env);
}
