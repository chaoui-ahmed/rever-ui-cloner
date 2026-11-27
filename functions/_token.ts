// /api/token-check: is this token safe to buy? Contract security (GoPlus, honeypot.is),
// market data (DexScreener) and the project's website (crypto-site-check), in one verdict. Not a route.
import type { Env } from "./_shared";
import { UpstreamError } from "./_shared";
import type { Micro } from "./_micro";

const CHAINS: Record<string, { goplus: string; honeypot?: number; aliases: string[] }> = {
  ethereum: { goplus: "1", honeypot: 1, aliases: ["eth", "mainnet", "1"] },
  bsc: { goplus: "56", honeypot: 56, aliases: ["bnb", "binance", "56"] },
  base: { goplus: "8453", honeypot: 8453, aliases: ["8453"] },
  arbitrum: { goplus: "42161", aliases: ["arb", "42161"] },
  polygon: { goplus: "137", aliases: ["matic", "137"] },
  optimism: { goplus: "10", aliases: ["op", "10"] },
  avalanche: { goplus: "43114", aliases: ["avax", "43114"] },
  solana: { goplus: "solana", aliases: ["sol"] },
};

const EVM = /^0x[a-fA-F0-9]{40}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateAddress(body: Record<string, unknown>): { ok: string } | { error: string } {
  const a = typeof body.address === "string" ? body.address.trim() : typeof body.contract === "string" ? body.contract.trim() : "";
  if (EVM.test(a) || SOL.test(a)) return { ok: a };
  return { error: 'Token contract address required in field "address" (EVM 0x... or Solana mint)' };
}

const normChain = (c: unknown): string | null => {
  if (typeof c !== "string" || !c.trim()) return null;
  const k = c.trim().toLowerCase();
  return Object.entries(CHAINS).find(([name, v]) => name === k || v.aliases.includes(k))?.[0] ?? null;
};

async function getJson(url: string, ms = 8000): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ReverBot/1.0 (+https://www.aypiai.online)" }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
const flag = (v: unknown) => v === "1" || v === 1 || v === true;

export const TOKEN_CHECK: Micro = {
  def: {
    path: "/api/token-check",
    priceUsd: "0.02",
    description:
      "Is this token safe to buy? One call returns a 0-100 safety score and verdict for any token contract (Ethereum, Base, BSC, Arbitrum, Polygon, Optimism, Avalanche, Solana): honeypot test (can you sell?), buy/sell tax, mint/pause/blacklist/owner powers, proxy and open-source status, liquidity and LP lock, holder concentration, pair age, volume, plus a check of the project's website (domain age, socials, scam signals). Auto-detects the chain. Heuristics from public on-chain data, not financial advice. Takes 2-8 s.",
    tags: ["crypto", "token", "honeypot", "rug-pull", "token-security", "scam-check", "defi", "memecoin", "trading", "due-diligence"],
    inputExample: { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", chain: "base" },
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Token contract address (EVM 0x... or Solana mint)" },
        chain: { type: "string", description: "Optional: ethereum, base, bsc, arbitrum, polygon, optimism, avalanche or solana. Auto-detected if omitted." },
      },
      required: ["address"],
    },
    outputExample: {
      address: "0x532f...42e4", chain: "base", name: "Brett", symbol: "BRETT", score: 88, verdict: "looks ok",
      honeypot: false, buyTaxPct: 0, sellTaxPct: 0, liquidityUsd: 12500000, pairAgeDays: 600,
      redFlags: [], greenFlags: ["Can be sold (no honeypot)", "Contract verified (open source)", "Ownership renounced"],
      website: { url: "https://www.basedbrett.com", score: 72, verdict: "low risk signals" },
    },
    outputSchema: { type: "object", properties: { score: { type: "number" }, verdict: { type: "string" }, honeypot: { type: ["boolean", "null"] }, redFlags: { type: "array" }, greenFlags: { type: "array" } }, required: ["score", "verdict"] },
    inputKey: "address",
  },
  run: async (env, address, body) => {
    const isSol = !EVM.test(address);
    const dex = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const pairs: any[] = (dex?.pairs ?? []).filter((p: any) => p?.baseToken?.address?.toLowerCase() === address.toLowerCase() || p?.quoteToken?.address?.toLowerCase() === address.toLowerCase());
    let chain = normChain(body.chain);
    if (!chain) {
      const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      chain = normChain(best?.chainId) ?? (isSol ? "solana" : null);
    }
    if (!chain) throw new UpstreamError('Could not detect the chain: no trading pair found. Pass "chain" (ethereum, base, bsc, arbitrum, polygon, optimism, avalanche, solana).');
    if (isSol !== (chain === "solana")) throw new UpstreamError(`Address format does not match chain ${chain}`);
    const cfg = CHAINS[chain];
    const chainPairs = pairs.filter((p) => normChain(p.chainId) === chain).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const main = chainPairs[0];

    const [gp, hp] = await Promise.all([
      getJson(chain === "solana"
        ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`
        : `https://api.gopluslabs.io/api/v1/token_security/${cfg.goplus}?contract_addresses=${address.toLowerCase()}`),
      cfg.honeypot ? getJson(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${cfg.honeypot}`) : Promise.resolve(null),
    ]);
    const sec: any = gp?.result?.[chain === "solana" ? address : address.toLowerCase()] ?? (gp?.result ? Object.values(gp.result)[0] : null);
    if (!sec && !main) throw new UpstreamError("No security or market data found for this token on " + chain);

    const red: string[] = [];
    const green: string[] = [];
    let score = 100;
    const bad = (pts: number, msg: string) => { score -= pts; red.push(msg); };

    // ---- honeypot / taxes ----
    let honeypot: boolean | null = null;
    let buyTax: number | null = null;
    let sellTax: number | null = null;
    if (hp?.honeypotResult) {
      honeypot = !!hp.honeypotResult.isHoneypot;
      buyTax = num(hp.simulationResult?.buyTax);
      sellTax = num(hp.simulationResult?.sellTax);
    }
    if (sec && chain !== "solana") {
      if (honeypot === null && sec.is_honeypot !== undefined) honeypot = flag(sec.is_honeypot);
      buyTax ??= sec.buy_tax !== undefined && sec.buy_tax !== "" ? Number(sec.buy_tax) * 100 : null;
      sellTax ??= sec.sell_tax !== undefined && sec.sell_tax !== "" ? Number(sec.sell_tax) * 100 : null;
      if (flag(sec.cannot_sell_all)) bad(30, "Holders cannot sell all their tokens");
      if (flag(sec.is_mintable)) bad(15, "Owner can mint new tokens");
      if (flag(sec.hidden_owner)) bad(20, "Hidden owner");
      if (flag(sec.can_take_back_ownership)) bad(20, "Ownership can be taken back after renouncing");
      if (flag(sec.owner_change_balance)) bad(30, "Owner can change balances");
      if (flag(sec.slippage_modifiable)) bad(15, "Tax can be changed by the owner");
      if (flag(sec.transfer_pausable)) bad(15, "Transfers can be paused");
      if (flag(sec.is_blacklisted)) bad(10, "Has a blacklist function");
      if (flag(sec.trading_cooldown)) bad(5, "Trading cooldown");
      if (flag(sec.is_proxy)) bad(10, "Upgradeable proxy: code can change");
      if (sec.is_open_source === "0") bad(25, "Contract source not verified");
      else if (sec.is_open_source === "1") green.push("Contract verified (open source)");
      const owner = String(sec.owner_address ?? "");
      if (!owner || /^0x0{40}$/i.test(owner) || /^0x0+dead$/i.test(owner)) green.push("Ownership renounced");
      const lpLocked = (sec.lp_holders ?? []).filter((h: any) => flag(h.is_locked)).reduce((s: number, h: any) => s + Number(h.percent ?? 0), 0);
      if (sec.lp_holders?.length) lpLocked >= 0.5 ? green.push(`${Math.round(lpLocked * 100)}% of liquidity locked or burned`) : bad(15, `Only ${Math.round(lpLocked * 100)}% of liquidity locked`);
      const ownerPct = Number(sec.owner_percent ?? 0) + Number(sec.creator_percent ?? 0);
      if (ownerPct > 0.2) bad(10, `Owner/creator hold ${Math.round(ownerPct * 100)}% of supply`);
      const top = (sec.holders ?? []).slice(0, 10).filter((h: any) => !flag(h.is_contract) && !flag(h.is_locked)).reduce((s: number, h: any) => s + Number(h.percent ?? 0), 0);
      if (top > 0.5) bad(10, `Top 10 wallets hold ${Math.round(top * 100)}%`);
    }
    if (sec && chain === "solana") {
      if (sec.mintable?.status === "1") bad(20, "Mint authority still active (supply can grow)");
      else green.push("Mint authority revoked");
      if (sec.freezable?.status === "1") bad(25, "Freeze authority active (your tokens can be frozen)");
      if (sec.closable?.status === "1") bad(15, "Token accounts can be closed by authority");
      if (sec.transfer_fee && Object.keys(sec.transfer_fee).length && Number(sec.transfer_fee?.current_fee_rate?.fee_rate ?? 0) > 0) bad(10, "Transfer fee on every transfer");
      if (sec.metadata_mutable?.status === "1") bad(5, "Metadata can be changed");
      if (flag(sec.non_transferable)) bad(40, "Token is non-transferable");
    }
    if (honeypot === true) bad(100, "HONEYPOT: simulation shows you cannot sell");
    else if (honeypot === false) green.push("Can be sold (no honeypot)");
    if (sellTax !== null && sellTax > 30) bad(40, `Sell tax ${sellTax.toFixed(1)}%`);
    else if (sellTax !== null && sellTax > 10) bad(20, `Sell tax ${sellTax.toFixed(1)}%`);
    if (buyTax !== null && buyTax > 10) bad(10, `Buy tax ${buyTax.toFixed(1)}%`);

    // ---- market ----
    const liq = main?.liquidity?.usd ?? null;
    const ageDays = main?.pairCreatedAt ? Math.floor((Date.now() - main.pairCreatedAt) / 86_400_000) : null;
    if (!main) bad(15, "No DEX trading pair found");
    else {
      if (liq !== null && liq < 10_000) bad(20, `Very low liquidity ($${Math.round(liq)})`);
      else if (liq !== null && liq < 50_000) bad(10, `Low liquidity ($${Math.round(liq)})`);
      else if (liq !== null && liq > 1_000_000) green.push(`Deep liquidity ($${(liq / 1e6).toFixed(1)}M)`);
      if (ageDays !== null && ageDays < 1) bad(15, "Trading pair created less than 24 h ago");
      else if (ageDays !== null && ageDays < 7) bad(5, `Trading pair only ${ageDays} days old`);
      else if (ageDays !== null && ageDays > 180) green.push(`Trading for ${ageDays} days`);
    }

    // ---- project website (reuses crypto-site-check) ----
    let website: Record<string, unknown> | null = null;
    const site = main?.info?.websites?.[0]?.url;
    if (site) {
      try {
        const { MICRO } = await import("./_micro");
        const csc = MICRO.find((m) => m.def.path === "/api/crypto-site-check");
        const r = (await csc!.run(env, site, {})) as any;
        website = { url: site, score: r.score, verdict: r.verdict, domainAgeDays: r.domainAgeDays ?? null, redFlags: (r.redFlags ?? []).slice(0, 5) };
        if (r.seedPhraseInput) bad(50, "Project website asks for a seed phrase (phishing)");
        else if (r.score < 35) bad(10, "Project website looks risky");
        else if (r.score >= 65) green.push("Project website looks legit");
      } catch { website = { url: site, error: "could not be checked" }; }
    } else if (main) bad(5, "No project website listed");

    score = Math.max(0, Math.min(100, score));
    const socials = (main?.info?.socials ?? []).map((s: any) => ({ type: s.type, url: s.url }));
    return {
      address,
      chain,
      name: main?.baseToken?.name ?? sec?.token_name ?? sec?.metadata?.name ?? null,
      symbol: main?.baseToken?.symbol ?? sec?.token_symbol ?? sec?.metadata?.symbol ?? null,
      score,
      verdict: honeypot === true || score < 30 ? "danger" : score < 50 ? "high risk" : score < 75 ? "caution" : "looks ok",
      honeypot,
      buyTaxPct: buyTax !== null ? Math.round(buyTax * 10) / 10 : null,
      sellTaxPct: sellTax !== null ? Math.round(sellTax * 10) / 10 : null,
      priceUsd: main?.priceUsd ? Number(main.priceUsd) : null,
      liquidityUsd: liq,
      volume24hUsd: main?.volume?.h24 ?? null,
      marketCapUsd: main?.marketCap ?? main?.fdv ?? null,
      pairAgeDays: ageDays,
      txns24h: main?.txns?.h24 ?? null,
      holders: sec?.holder_count ? Number(sec.holder_count) : sec?.holders?.length ?? null,
      dex: main ? { name: main.dexId, url: main.url, pairs: chainPairs.length } : null,
      socials,
      website,
      redFlags: red,
      greenFlags: green,
      sources: ["GoPlus Security", ...(hp ? ["honeypot.is"] : []), ...(main ? ["DexScreener"] : []), ...(website ? ["Rever crypto-site-check"] : [])],
      disclaimer: "Automated heuristics from public on-chain and web data. Not financial advice.",
    };
  },
};
