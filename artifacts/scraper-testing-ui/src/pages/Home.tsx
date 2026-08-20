import { ApiKeyInput } from '@/components/ApiKeyInput';
import { HealthIndicator } from '@/components/HealthIndicator';
import { ScrapeForm, ScrapeMode } from '@/components/ScrapeForm';
import { ResultsPanel } from '@/components/ResultsPanel';
import { LoadingState } from '@/components/LoadingState';
import { useScrape, useDiscoverArticles, ScrapeRequestRoute } from '@workspace/api-client-react';
import { useState } from 'react';

export default function Home() {
  const { mutate, isPending, data, error } = useScrape();
  const discovery = useDiscoverArticles();
  const [mode, setMode] = useState<ScrapeMode>('core');
  const activePending = mode === 'core' ? isPending : discovery.isPending;

  const handleScrape = (url: string, route: ScrapeRequestRoute, targetMonth?: string, targetYear?: string) => {
    mutate({
      data: { url, route: route === 'generic' ? undefined : route }
    });
  };
  const handleSubmit = (url: string, route: ScrapeRequestRoute, targetMonth?: string, targetYear?: string) => {
    if (mode === 'core') {
      handleScrape(url, route);
    } else {
      discovery.mutate({ data: { url, ...(targetMonth ? { targetMonth } : {}), ...(targetYear ? { targetYear } : {}) } });
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans">
      <header className="flex items-center justify-between px-6 py-4 border-b bg-card shadow-sm z-10 sticky top-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary text-primary-foreground rounded-lg flex items-center justify-center font-bold font-mono text-sm shadow-sm">
              PN
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Scraper Test</h1>
          </div>
          <div className="h-6 w-px bg-border mx-2" />
          <HealthIndicator />
        </div>
        <ApiKeyInput />
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto py-12 px-6">
        <div className="mb-10 space-y-3">
          <h2 className="text-3xl font-bold tracking-tight">Test Extraction Pipeline</h2>
          <p className="text-muted-foreground text-lg">Enter a payer webpage or PDF URL and review the structured content extraction.</p>
        </div>
        
        <div className="bg-card border rounded-xl p-6 md:p-8 shadow-sm mb-8">
          <ScrapeForm onSubmit={handleSubmit} isPending={activePending} mode={mode} onModeChange={(next) => {
            setMode(next);
            mutate.reset();
            discovery.reset();
          }} />
        </div>
        
        {activePending && <LoadingState />}
        
        {!activePending && mode === 'core' && (data || error) && (
          <ResultsPanel data={data} error={error} />
        )}
        {!activePending && mode === 'discovery' && (discovery.data || discovery.error) && (
          <ResultsPanel discoveryData={discovery.data} error={discovery.error} />
        )}
      </main>
    </div>
  );
}