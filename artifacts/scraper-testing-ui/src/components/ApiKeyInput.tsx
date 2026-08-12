import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Eye, EyeOff, Key } from 'lucide-react';

export function ApiKeyInput() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('payernews_api_key') || '');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    sessionStorage.setItem('payernews_api_key', apiKey);
  }, [apiKey]);

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-72">
        <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type={showKey ? 'text' : 'password'}
          placeholder="Enter API Key to scrape..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="pl-9 pr-9 font-mono text-sm bg-muted/30 focus:bg-background h-10"
          data-testid="input-api-key"
        />
        <button
          type="button"
          onClick={() => setShowKey(!showKey)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 rounded-md"
          data-testid="button-toggle-key"
          title={showKey ? "Hide API Key" : "Show API Key"}
        >
          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}