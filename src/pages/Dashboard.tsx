import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Loader2,
  Coins,
  Link as LinkIcon,
  Zap,
  Copy,
  Check,
  Globe,
  Search,
  ExternalLink,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import reverLogo from "@/assets/rever-logo.png";
import reverIcon from "@/assets/rever-icon.png";
import BuyDialog from "@/components/BuyDialog";
import { getAccessKey, setAccessKey as storeAccessKey, consumeSessionIdFromUrl, fetchBalance } from "@/lib/access";
import { loadShowcase, type Site } from "@/data/showcase";
import { LiquidMetalButton } from "@/components/liquid-metal-button";
import SiteTimeMachine from "@/components/SiteTimeMachine";

const Dashboard = () => {
  const [accessKey, setAccessKeyState] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedPrompt, setGeneratedPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isBuyOpen, setIsBuyOpen] = useState(false);

  // Showcase state
  const [sites, setSites] = useState<Site[]>([]);
  const [showcaseFilter, setShowcaseFilter] = useState("all");
  const [showcaseSearch, setShowcaseSearch] = useState("");
  const [loadingShowcase, setLoadingShowcase] = useState(true);

  const useKey = async (key: string, announce = false) => {
    try {
      const balance = await fetchBalance(key);
      storeAccessKey(key);
      setAccessKeyState(key);
      setRemaining(balance);
      if (announce) toast.success(`Payment confirmed: ${balance} generations available`);
      setIsBuyOpen(false);
    } catch (err: any) {
      toast.error(err.message || "Invalid access key");
    }
  };

  const forgetKey = () => {
    storeAccessKey(null);
    setAccessKeyState(null);
    setRemaining(null);
  };

  useEffect(() => {
    const fromStripe = consumeSessionIdFromUrl();
    const stored = getAccessKey();
    if (fromStripe) useKey(fromStripe, true);
    else if (stored) useKey(stored);

    loadShowcase()
      .then(setSites)
      .catch(() => toast.error("Failed to load the showcase"))
      .finally(() => setLoadingShowcase(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasCredits = accessKey !== null && remaining !== null && remaining > 0;

  const handleGenerate = async () => {
    let finalUrl = url.trim();
    if (!finalUrl) {
      toast.error("Please enter a URL");
      return;
    }
    if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
      finalUrl = "https://" + finalUrl;
    }
    if (!hasCredits || !accessKey) return;

    setGenerating(true);
    setGeneratedPrompt(null);
    try {
      const res = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Key": accessKey },
        body: JSON.stringify({ url: finalUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (typeof data.remaining === "number") setRemaining(data.remaining);
        throw new Error(data.error || "Failed to generate prompt");
      }
      setGeneratedPrompt(data.prompt);
      setRemaining(data.remaining);
      toast.success("Prompt generated!");
    } catch (err: any) {
      toast.error(err.message || "Failed to generate prompt");
    } finally {
      setGenerating(false);
    }
  };

  const handleUpgrade = () => setIsBuyOpen(true);

  const handleCopy = async () => {
    if (!generatedPrompt) return;
    await navigator.clipboard.writeText(generatedPrompt);
    setCopied(true);
    toast.success("Copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const filteredSites = sites.filter(site => {
    const matchesFilter = showcaseFilter === "all" || site.platform === showcaseFilter;
    const matchesSearch = site.domain.toLowerCase().includes(showcaseSearch.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-background flex flex-col selection:bg-primary/20">
      <header className="border-b border-white/10 sticky top-0 z-10 bg-background/60 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-20">
          <img src={reverLogo} alt="REVER" className="h-14 w-auto filter drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]" />
          <div className="flex items-center gap-3">
            <a href="/showcase" className="text-sm text-muted-foreground hover:text-foreground hidden sm:inline">Showcase</a>
            <button
              onClick={() => setIsBuyOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-secondary px-3.5 py-1.5 text-sm font-medium hover:bg-secondary/80"
              aria-label="Generations left — buy more"
            >
              <Coins className="h-4 w-4 text-primary" />
              <span className="text-foreground">{remaining !== null ? remaining : "Buy"}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-12 relative">
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

        <Tabs defaultValue="generate" className="w-full space-y-12 relative z-10">
          <div className="flex justify-center">
            <TabsList className="grid w-full max-w-[400px] grid-cols-2 bg-secondary/50 backdrop-blur-md border border-white/5">
              <TabsTrigger value="generate" className="gap-2 data-[state=active]:bg-white/10">
                <Zap className="h-4 w-4" /> Generator
              </TabsTrigger>
              <TabsTrigger value="showcase" className="gap-2 data-[state=active]:bg-white/10">
                <Globe className="h-4 w-4" /> Showcase
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="generate" className="space-y-10 focus-visible:outline-none flex flex-col items-center animate-in fade-in duration-700">
            <div className="text-center space-y-6 pt-6">
              <img src={reverIcon} alt="REVER" className="h-28 mx-auto filter drop-shadow-[0_0_30px_rgba(255,255,255,0.15)] animate-in zoom-in duration-700" />
              <div className="space-y-3">
                <h1 className="text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-white/50">
                  REVƎЯ
                </h1>
                <p className="text-muted-foreground text-lg max-w-md mx-auto font-light">Paste the url and generate your prompt.</p>
              </div>
            </div>

            <div className="w-full max-w-xl space-y-8 flex flex-col items-center">
              <div className="relative w-full group">
                <div className="absolute -inset-0.5 bg-gradient-to-r from-white/10 to-white/5 rounded-xl blur opacity-30 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
                <div className="relative flex items-center bg-card border border-white/10 rounded-xl overflow-hidden shadow-2xl">
                  <LinkIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground/50" />
                  <Input type="url" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} className="h-16 pl-12 pr-4 text-lg bg-transparent border-none focus-visible:ring-0 placeholder:text-muted-foreground/30" />
                </div>
              </div>

              <div className="pt-4 flex flex-col items-center scale-110">
                <LiquidMetalButton 
                  label={generating ? "Extracting..." : "Generate Prompt"} 
                  onClick={hasCredits ? handleGenerate : handleUpgrade} 
                  viewMode="text" 
                />
                {!hasCredits && (
                  <p className="text-center text-sm text-muted-foreground mt-8">
                    {accessKey ? "No generations left." : "Buy a pack to start."}{" "}<button onClick={handleUpgrade} className="text-primary underline hover:text-primary/80">See packs</button>
                  </p>
                )}
              </div>

              {generatedPrompt && (
                <div className="w-full rounded-xl border border-white/10 bg-card/50 backdrop-blur-md p-6 space-y-4 mt-8 shadow-2xl animate-in fade-in slide-in-from-bottom-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Generated Prompt</h2>
                    <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10">
                      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <p className="text-foreground whitespace-pre-wrap leading-relaxed text-sm">{generatedPrompt}</p>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="showcase" className="space-y-6 focus-visible:outline-none animate-in fade-in duration-700">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-end md:items-center">
              <div>
                <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-b from-white to-white/50">The Archive</h2>
              </div>
              <div className="flex gap-2 w-full md:w-auto">
                <div className="relative flex-1 md:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Rechercher..." className="pl-9 bg-black/20 border-white/5 focus-visible:ring-1 focus-visible:ring-primary" value={showcaseSearch} onChange={(e) => setShowcaseSearch(e.target.value)} />
                </div>
                <select className="bg-secondary/50 text-sm rounded-md px-3 border border-white/5 focus:ring-1 ring-primary" value={showcaseFilter} onChange={(e) => setShowcaseFilter(e.target.value)}>
                  <option value="all">Tous</option>
                  <option value="vercel">Vercel</option>
                  <option value="lovable">Lovable</option>
                </select>
              </div>
            </div>

            {loadingShowcase ? (
              <div className="flex justify-center py-32"><div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>
            ) : (
              <div className="space-y-24 mt-8">
                <div>
                  <SiteTimeMachine sites={filteredSites} />
                </div>

                <div className="w-full max-w-4xl mx-auto border-t border-white/5 pt-12 pb-20">
                  <div className="flex items-center justify-between mb-8 px-2">
                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-[0.2em] opacity-40">Index Aléatoire</h3>
                    <span className="text-[10px] font-mono text-muted-foreground/30">{filteredSites.length} domaines répertoriés</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filteredSites.map((site) => (
                      <a
                        key={site.id}
                        href={`https://${site.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between p-3.5 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] hover:border-white/10 transition-all group"
                      >
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div className="w-8 h-8 rounded-lg bg-secondary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                            <Globe className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                          </div>
                          <span className="text-sm font-medium truncate opacity-60 group-hover:opacity-100 transition-opacity">
                            {site.domain}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-white/10 text-muted-foreground/40 uppercase font-bold">
                            {site.platform}
                          </Badge>
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/10 group-hover:text-primary transition-colors" />
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <BuyDialog open={isBuyOpen} onOpenChange={setIsBuyOpen} accessKey={accessKey} onUseKey={(k) => useKey(k, true)} onForgetKey={forgetKey} />
    </div>
  );
};

export default Dashboard;