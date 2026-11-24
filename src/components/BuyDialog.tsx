import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Zap, Crown, CreditCard, KeyRound } from "lucide-react";
import { STRIPE_PACKS } from "@/lib/access";

interface BuyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessKey: string | null;
  onUseKey: (key: string) => void;
  onForgetKey: () => void;
}

const icons = { starter: Zap, pro: Crown, pro_plus: CreditCard };

const BuyDialog = ({ open, onOpenChange, accessKey, onUseKey, onForgetKey }: BuyDialogProps) => {
  const [keyInput, setKeyInput] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Buy generations</DialogTitle>
          <DialogDescription>
            One generation = one URL turned into a prompt. After paying you come back here automatically and your
            access key is saved in this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 pt-2">
          {STRIPE_PACKS.map((pack) => {
            const Icon = icons[pack.id];
            return (
              <a
                key={pack.id}
                href={pack.url}
                className="flex items-center justify-between rounded-lg border border-white/10 p-4 hover:bg-white/5 transition-colors"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Icon className="h-4 w-4 text-primary" />
                  {pack.name} — {pack.generations} generations
                </span>
                <span className="font-semibold">{pack.price}</span>
              </a>
            );
          })}
        </div>

        <div className="space-y-2 border-t border-white/10 pt-4">
          <Label htmlFor="access-key" className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Already paid? Paste your access key
          </Label>
          <div className="flex gap-2">
            <Input
              id="access-key"
              placeholder="cs_live_..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <Button onClick={() => keyInput.trim() && onUseKey(keyInput.trim())}>Use</Button>
          </div>
          {accessKey && (
            <p className="text-xs text-muted-foreground break-all">
              Current key: {accessKey} ·{" "}
              <button className="underline" onClick={onForgetKey}>
                forget
              </button>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Credits work on all 40 API and MCP tools. AI agents can also pay per call in USDC with x402. See <a className="underline" href="/llms.txt">llms.txt</a>.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BuyDialog;
