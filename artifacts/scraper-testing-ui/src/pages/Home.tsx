import { ApiKeyInput } from '@/components/ApiKeyInput';
import { HealthIndicator } from '@/components/HealthIndicator';
import { ScrapeForm } from '@/components/ScrapeForm';
import { ResultsPanel } from '@/components/ResultsPanel';
import { LoadingState } from '@/components/LoadingState';
import { useScrape, ScrapeRequestRoute } from '@workspace/api-client-react';

export default function Home() {
  const { mutate, isPending, data, error } = useScrape();

  const handleScrape = (url: string, route: ScrapeRequestRoute) => {
    mutate({
      data: { url, route: route === 'generic' ? undefined : route }
    });
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
          <p className="text-muted-foreground text-lg">Enter a payer webpage URL and review the structured content extraction.</p>
        </div>
        
        <div className="bg-card border rounded-xl p-6 md:p-8 shadow-sm mb-8">
          <ScrapeForm onSubmit={handleScrape} isPending={isPending} />
        </div>
        
        {isPending && <LoadingState />}
        
        {!isPending && (data || error) && (
          <ResultsPanel data={data} error={error} />
        )}
      </main>
    </div>
  );
}