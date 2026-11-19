// Access key = Stripe Checkout Session id, kept in this browser only.
const STORAGE_KEY = "rever_access_key";

export const STRIPE_PACKS = [
  { id: "starter", name: "Starter", generations: 10, price: "9,99 €", url: "https://buy.stripe.com/aFaeVc2Regul0Ei1PSawo02" },
  { id: "pro", name: "Pro", generations: 25, price: "19,99 €", url: "https://buy.stripe.com/3cI7sKbnKgul3Qu668awo03" },
  { id: "pro_plus", name: "Pro+", generations: 70, price: "49,99 €", url: "https://buy.stripe.com/4gM4gy2Re7XPbiW1PSawo04" },
] as const;

export function getAccessKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAccessKey(key: string | null) {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: key lives only in memory for this visit */
  }
}

/** After a Stripe payment, Stripe redirects to /?session_id=cs_... — pick it up and clean the URL. */
export function consumeSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("session_id");
  if (!id) return null;
  params.delete("session_id");
  const qs = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  return id;
}

export async function fetchBalance(key: string): Promise<number> {
  const res = await fetch("/api/balance", { headers: { "X-Access-Key": key } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Invalid access key");
  return data.remaining;
}
