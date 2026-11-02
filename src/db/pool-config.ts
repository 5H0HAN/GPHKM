export const DEFAULT_APP_DB_POOL_MAX = 5;
export const MAX_APP_DB_POOL_MAX = 50;

export function applicationDbPoolMax(raw: string | undefined) {
  const configured = raw?.trim();
  const value = configured ? Number(configured) : DEFAULT_APP_DB_POOL_MAX;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_APP_DB_POOL_MAX) {
    throw new Error(`GPHKM_DB_POOL_MAX must be an integer between 1 and ${MAX_APP_DB_POOL_MAX}`);
  }
  return value;
}
