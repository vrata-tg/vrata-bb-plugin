import { z } from "zod";
import { buildUserAgent } from "./user-agent.js";

const atoms = z.string().regex(/^-?\d{1,40}$/);

const accountSchema = z.object({
  checked_at: z.string(),
  balance: z.object({
    currency: z.literal("RUB"),
    unit: z.literal("coin_atoms"),
    paid_available: atoms,
    promo_available: atoms,
    reserved: atoms,
    spendable: atoms,
  }),
});

export const balanceResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unconfigured") }),
  z.object({ status: z.literal("error"), message: z.string() }),
  z.object({
    status: z.literal("ok"),
    checkedAt: z.string(),
    spendable: atoms,
    paid: atoms,
    promo: atoms,
    reserved: atoms,
  }),
]);

export type BalanceResult = z.infer<typeof balanceResultSchema>;

export async function fetchBalance(apiUrl: string, apiKey: string, signal?: AbortSignal, userAgent = buildUserAgent()): Promise<BalanceResult> {
  try {
    const response = await fetch(`${apiUrl}/account`, {
      headers: { authorization: `Bearer ${apiKey}`, "User-Agent": userAgent },
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "error", message: "Проверьте ключ Врата AI для выбранной машины в настройках плагина." };
    }
    if (!response.ok) return { status: "error", message: "Не удалось получить баланс Врата AI. Повторите попытку." };
    const account = accountSchema.parse(await response.json());
    return {
      status: "ok",
      checkedAt: account.checked_at,
      spendable: account.balance.spendable,
      paid: account.balance.paid_available,
      promo: account.balance.promo_available,
      reserved: account.balance.reserved,
    };
  } catch {
    return { status: "error", message: "Баланс Врата AI временно недоступен. Повторите попытку." };
  }
}

/** One ruble is 1,000,000 atoms. Round to kopecks without losing integer precision. */
export function formatRubles(value: string): string {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const kopecks = (absolute + 5_000n) / 10_000n;
  const rubles = new Intl.NumberFormat("ru-RU").format(kopecks / 100n);
  return `${amount < 0n && kopecks !== 0n ? "−" : ""}${rubles},${String(kopecks % 100n).padStart(2, "0")} ₽`;
}
