export interface Site {
  id: number;
  domain: string;
  platform: "vercel" | "lovable";
}

let cache: Promise<Site[]> | null = null;

/** Loads the static showcase directory (public/showcase.json), shuffled. */
export function loadShowcase(): Promise<Site[]> {
  cache ??= fetch("/showcase.json")
    .then((r) => r.json() as Promise<{ vercel: string[]; lovable: string[] }>)
    .then(({ vercel, lovable }) => {
      const sites: Site[] = [
        ...vercel.map((domain) => ({ domain, platform: "vercel" as const })),
        ...lovable.map((domain) => ({ domain, platform: "lovable" as const })),
      ].map((s, id) => ({ ...s, id }));
      for (let i = sites.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sites[i], sites[j]] = [sites[j], sites[i]];
      }
      return sites;
    });
  return cache;
}
