import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Globe, Play } from 'lucide-react';
import { ScrapeRequestRoute } from '@workspace/api-client-react';

export type ScrapeMode = 'core' | 'discovery';

export function ScrapeForm({
  onSubmit,
  isPending,
  mode,
  onModeChange,
}: {
  onSubmit: (url: string, route: ScrapeRequestRoute, targetMonth?: string, targetYear?: string) => void;
  isPending: boolean;
  mode: ScrapeMode;
  onModeChange: (mode: ScrapeMode) => void;
}) {
  const [url, setUrl] = useState('');
  const [route, setRoute] = useState<ScrapeRequestRoute>('generic');
  const [targetMonth, setTargetMonth] = useState('');
  const [targetYear, setTargetYear] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) {
      setError('Please enter a URL');
      return;
    }
    const key = localStorage.getItem('payernews_api_key');
    if (!key) {
      setError('API key is missing. Please enter your API key in the top right header.');
      return;
    }
    if (mode === 'discovery' && Boolean(targetMonth) !== Boolean(targetYear)) {
      setError('Choose both a target month and year, or leave both blank for the previous month.');
      return;
    }
    setError('');
    onSubmit(url, route, targetMonth || undefined, targetYear || undefined);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex gap-2 rounded-lg bg-muted p-1 w-full md:w-fit" role="group" aria-label="API mode">
        <button
          type="button"
          onClick={() => { onModeChange('core'); setError(''); }}
          disabled={isPending}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${mode === 'core' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          data-testid="toggle-core-api"
        >
          Core API
        </button>
        <button
          type="button"
          onClick={() => { onModeChange('discovery'); setError(''); }}
          disabled={isPending}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${mode === 'discovery' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          data-testid="toggle-discovery"
        >
          Monthly Discovery
        </button>
      </div>
      <div className="flex flex-col md:flex-row items-start md:items-center gap-4">
        <div className="relative flex-1 w-full">
          <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(''); }}
            placeholder={mode === 'discovery' ? 'https://example.com/payer-news' : 'https://example.com/payer-policy-or-document.pdf'}
            className="pl-11 h-12 text-base w-full shadow-sm"
            disabled={isPending}
            data-testid="input-url"
          />
        </div>
        {mode === 'core' ? <select
          value={route}
          onChange={(e) => setRoute(e.target.value as ScrapeRequestRoute)}
          disabled={isPending}
          className="h-12 px-4 rounded-md border border-input bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent min-w-[140px] w-full md:w-auto shadow-sm"
          data-testid="select-route"
        >
          <option value="generic">Generic (Auto)</option>
          <option value="anthem">Anthem / Elevance</option>
          <option value="aetna">Aetna / CVS</option>
          <option value="uhc">UHC / Optum</option>
          <option value="cigna">Cigna / Evernorth</option>
          <option value="bcbs">BCBS / Blue Cross</option>
          <option value="tmhp">TMHP (Texas Medicaid)</option>
          <option value="nhpri">NHPRI (RI Medicaid)</option>
        </select> : (
          <div className="flex gap-2 w-full md:w-auto">
            <select
              value={targetMonth}
              onChange={(e) => { setTargetMonth(e.target.value); setError(''); }}
              disabled={isPending}
              aria-label="Target month"
              className="h-12 px-3 rounded-md border border-input bg-background text-sm min-w-[130px]"
              data-testid="select-target-month"
            >
              <option value="">Previous month</option>
              {['January','February','March','April','May','June','July','August','September','October','November','December'].map(month => <option key={month} value={month}>{month}</option>)}
            </select>
            <Input
              value={targetYear}
              onChange={(e) => { setTargetYear(e.target.value); setError(''); }}
              placeholder="Year"
              inputMode="numeric"
              maxLength={4}
              disabled={isPending}
              aria-label="Target year"
              className="h-12 w-24"
              data-testid="input-target-year"
            />
          </div>
        )}
        <Button 
          type="submit" 
          disabled={isPending} 
          className="h-12 px-8 font-semibold w-full md:w-auto shadow-sm"
          data-testid="button-scrape"
        >
          {isPending ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-current" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {mode === 'discovery' ? 'Discovering' : 'Scraping'}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Play className="h-4 w-4" fill="currentColor" />
              {mode === 'discovery' ? 'Discover' : 'Scrape'}
            </span>
          )}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive font-medium" data-testid="text-form-error">{error}</p>}
    </form>
  );
}