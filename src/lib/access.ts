// Access key = Stripe Checkout Session id, kept in this browser only.
const STORAGE_KEY = "rever_access_key";

// Card credits, valid on every tool. A UI-recreation prompt costs $0.05 of credit.
export const STRIPE_PACKS = [
  { id: "starter", name: "Starter", generations: 100, price: "$5", url: "/api/buy?pack=5&return=app" },
  { id: "pro", name: "Pro", generations: 440, price: "$20", url: "/api/buy?pack=20&return=app" },
  { id: "pro_plus", name: "Pro+", generations: 1200, price: "$50", url: "/api/buy?pack=50&return=app" },
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
  return typeof data.balanceUsd === "number" ? Math.floor((data.balanceUsd + 1e-9) / 0.05) : data.remaining;
}
