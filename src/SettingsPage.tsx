import { useEffect, useState } from "react";
import type { Account, AddonContext } from "@wealthfolio/addon-sdk";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Icons,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { loadSettings, saveSettings } from "./settings";
import type { AddonSettings } from "./types";

function securityMappingLabel(m: AddonSettings["securityMappings"][string]): string {
  if (m === "custom") return "Custom (ISIN as symbol)";
  return `${m.canonicalSymbol || m.symbol}${m.shortName ? ` — ${m.shortName}` : ""}`;
}

function AccountSelect({
  accounts,
  value,
  onChange,
}: {
  accounts: Account[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select account…" />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name} <span className="text-muted-foreground">({a.currency})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MappingRow({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <Button type="button" variant="ghost" size="icon" onClick={onRemove} className="shrink-0">
        <Icons.Trash className="text-muted-foreground h-4 w-4" />
      </Button>
    </div>
  );
}

export function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<AddonSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([ctx.api.accounts.getAll(), loadSettings(ctx)]).then(([accs, s]) => {
      setAccounts(accs.filter((a) => a.isActive && !a.isArchived));
      setSettings(s);
    });
  }, []);

  if (!settings) {
    return <div className="text-muted-foreground p-6 text-sm">Loading settings…</div>;
  }

  const set = (patch: Partial<AddonSettings>) => {
    setSaved(false);
    setSettings((s) => ({ ...s!, ...patch }));
  };

  const removeSecurityMapping = (isin: string) => {
    const { [isin]: _removed, ...rest } = settings.securityMappings;
    set({ securityMappings: rest });
  };

  const clearAllSecurityMappings = () => set({ securityMappings: {} });

  const handleSave = async () => {
    if (!settings.accountId) {
      setError("Please select your MyInvestor/Inversis account.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await saveSettings(ctx, settings);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">MyInvestor / Inversis Importer — Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Configure once; settings are saved securely and pre-filled on every import.
        </p>
      </div>

      {/* Account */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-xs">
            MyInvestor/Inversis keeps cash and securities in a single account — unlike Trade Republic,
            there's no cash/portfolio split to configure. Select the Wealthfolio account that
            represents your MyInvestor/Inversis cuenta.
          </p>
          <div className="space-y-1">
            <Label>MyInvestor/Inversis account</Label>
            <AccountSelect
              accounts={accounts}
              value={settings.accountId}
              onChange={(v) => set({ accountId: v })}
            />
            <p className="text-muted-foreground text-xs">
              Receives deposits, fees, interest, and all fund buy/sell/switch activity. USD-denominated
              funds are booked with an explicit FX rate so cash still settles correctly in EUR.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Security mappings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Security mappings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">
            Once an ISIN is mapped to a ticker (or marked custom) during import, it's remembered here
            so future imports of the same fund skip the mapping step. Remove an entry to be asked
            again next time it's imported.
          </p>
          {Object.keys(settings.securityMappings).length === 0 ? (
            <p className="text-muted-foreground text-xs italic">No security mappings saved yet.</p>
          ) : (
            <>
              <div className="space-y-1">
                {Object.entries(settings.securityMappings).map(([isin, mapping]) => (
                  <MappingRow key={isin} onRemove={() => removeSecurityMapping(isin)}>
                    <span className="w-32 shrink-0 font-mono text-xs font-bold">{isin}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {securityMappingLabel(mapping)}
                    </span>
                  </MappingRow>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={clearAllSecurityMappings}>
                <Icons.Trash className="mr-1 h-4 w-4" />
                Clear all
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {saved && (
          <span className="text-muted-foreground flex items-center gap-1 text-sm">
            <Icons.Check className="h-4 w-4 text-green-600" />
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
