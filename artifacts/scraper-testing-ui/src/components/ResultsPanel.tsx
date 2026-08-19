import type { ScrapeResponse } from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CheckCircle2, AlertCircle, Copy, Check, Clock, Globe2, FileText, Activity } from 'lucide-react';
import { useState } from 'react';

/** Checks whether an unknown value looks like a ScrapeResponse payload. */
function isScrapeResponse(val: unknown): val is ScrapeResponse {
  return (
    typeof val === 'object' &&
    val !== null &&
    'success' in val &&
    'url' in val &&
    'finalUrl' in val &&
    'durationMs' in val &&
    'content' in val
  );
}

function getStatusErrorMessage(error: any): string {
  // Always prefer the server's own error string — covers ErrorResponse { success, error }
  // and ScrapeResponse.error alike, before falling back to canned status messages.
  const serverMsg: string | undefined = error?.data?.error;
  if (serverMsg) return serverMsg;

  const status = error?.status;
  if (status === 401) return "Unauthorized: Invalid or missing API key. Please check your key at the top of the page.";
  if (status === 403) return "Forbidden: This URL is blocked (SSRF protection or WAF blocked the request).";
  if (status === 422) return "Unprocessable Entity: Content could not be extracted from this page.";
  if (status === 504) return "Gateway Timeout: The scraper timed out. The page may be very slow or blocking scrapers.";
  if (status != null) return `HTTP ${status}: The scraper encountered an unexpected error.`;
  return error?.message ?? "An unexpected error occurred.";
}

export function ResultsPanel({ data, error }: { data?: ScrapeResponse; error?: any }) {
  const [copied, setCopied] = useState(false);

  // The scraper API always returns a structured ScrapeResponse — even on failure
  // (non-2xx). customFetch throws an ApiError whose .data property carries the
  // parsed response body. Prefer that over the canned status message so testers
  // can inspect the full result (route, engine, timing, content, etc.) on errors.
  const errorResponseData = isScrapeResponse(error?.data) ? error.data : undefined;
  const result: ScrapeResponse | undefined = data ?? errorResponseData;

  const isSuccess = result?.success === true && !error;

  // Prefer the server's own error field, fall back to a status-derived message.
  const serverError = result?.error ?? null;
  const errorMessage = error
    ? (serverError ?? getStatusErrorMessage(error))
    : serverError;

  const handleCopy = () => {
    if (result?.content) {
      navigator.clipboard.writeText(result.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="mt-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-tight">Result</h3>
        <Badge
          variant={isSuccess ? 'success' : 'destructive'}
          className="px-3 py-1.5 text-sm font-medium gap-1.5 rounded-full"
          data-testid="badge-status"
        >
          {isSuccess ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {isSuccess ? 'Success' : 'Failed'}
        </Badge>
      </div>

      {/* Always render the full metadata panel if we have any structured response */}
      {result ? (
        <Card className="overflow-hidden shadow-sm">
          <div className="bg-muted/40 p-5 border-b grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
            <div>
              <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" /> Document
              </p>
              <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-document-type">
                {(result.documentType ?? 'html').toUpperCase()}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" /> Route
              </p>
              <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-route">
                {result.route}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Engine
              </p>
              <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-engine">
                {result.scraperUsed || 'unknown'}
              </p>
            </div>
            {result.documentType === 'pdf' && (
              <>
                <div>
                  <p className="text-muted-foreground mb-1.5">Pages</p>
                  <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-page-count">
                    {result.pageCount ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1.5">Native pages</p>
                  <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-native-pages">
                    {result.nativePages ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1.5">OCR pages</p>
                  <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-ocr-pages">
                    {result.ocrPages ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1.5">OCR used</p>
                  <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-ocr-used">
                    {result.ocrUsed ? 'Yes' : 'No'}
                  </p>
                </div>
              </>
            )}
            <div>
              <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Globe2 className="w-3.5 h-3.5" /> HTTP Status
              </p>
              <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-statuscode">
                {result.statusCode}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Duration
              </p>
              <p className="font-medium font-mono text-[13px] bg-background px-2 py-1 rounded border inline-block" data-testid="text-duration">
                {result.durationMs > 1000
                  ? (result.durationMs / 1000).toFixed(1) + 's'
                  : result.durationMs + 'ms'}
              </p>
            </div>
            <div className="col-span-2 md:col-span-4">
              <p className="text-muted-foreground mb-1.5">Final URL</p>
              <p className="font-medium truncate text-blue-600 hover:underline" title={result.finalUrl} data-testid="text-finalurl">
                <a href={result.finalUrl} target="_blank" rel="noreferrer">
                  {result.finalUrl}
                </a>
              </p>
            </div>
            <div className="col-span-2 md:col-span-4">
              <p className="text-muted-foreground mb-1.5">Page Title</p>
              <p className="font-medium text-base leading-snug" data-testid="text-title">
                {result.title || 'No title found'}
              </p>
            </div>
          </div>

          {/* Error message — shown for failures whether server-provided or status-derived */}
          {(!isSuccess || errorMessage) && errorMessage && (
            <div
              className="p-4 bg-destructive/5 border-b border-destructive/10 text-destructive text-sm font-medium"
              data-testid="text-error-message"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p>{errorMessage}</p>
              </div>
            </div>
          )}

          {/* Content panel */}
          <div className="relative">
            <div className="absolute right-4 top-4 flex items-center gap-2 z-10">
              {result.truncated && (
                <Badge
                  variant="warning"
                  className="bg-warning text-warning-foreground border-0 shadow-sm"
                  data-testid="badge-truncated"
                >
                  Truncated
                </Badge>
              )}
              {result.content && (
                <button
                  onClick={handleCopy}
                  className="flex items-center justify-center w-8 h-8 rounded-md bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 transition-colors text-zinc-300"
                  title="Copy content"
                  data-testid="button-copy"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              )}
            </div>
            <div className="p-5 bg-zinc-950 text-zinc-50 overflow-x-auto relative rounded-b-xl">
              <div className="flex justify-between items-center mb-4 text-xs text-zinc-400 pb-3 border-b border-zinc-800">
                <span className="font-semibold uppercase tracking-wider">Extracted Content</span>
                <span className="font-mono bg-zinc-900 px-2 py-1 rounded text-zinc-300">
                  {result.contentLength.toLocaleString()} chars
                </span>
              </div>
              <pre
                className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-y-auto pr-4 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent"
                data-testid="pre-content"
              >
                {result.content || (
                  <span className="text-zinc-600 italic">No content extracted.</span>
                )}
              </pre>
            </div>
          </div>
        </Card>
      ) : (
        /* Fallback: error with no structured response body (e.g. network failure, 401) */
        error && (
          <Card className="p-6 border-destructive/20 bg-destructive/5 text-destructive shadow-sm">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-6 h-6 shrink-0" />
              <div>
                <h4 className="font-semibold text-lg mb-1">Request Failed</h4>
                <p className="opacity-90 leading-relaxed" data-testid="text-error-message">
                  {getStatusErrorMessage(error)}
                </p>
              </div>
            </div>
          </Card>
        )
      )}
    </div>
  );
}
