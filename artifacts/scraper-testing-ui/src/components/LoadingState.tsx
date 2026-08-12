export function LoadingState() {
  return (
    <div className="mt-8 py-16 flex flex-col items-center justify-center border rounded-xl bg-muted/20 border-dashed animate-in fade-in duration-500">
      <div className="relative w-16 h-16 flex items-center justify-center mb-6">
        <div className="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary animate-spin" style={{ animationDuration: '1s' }}></div>
        <div className="w-8 h-8 rounded-full bg-primary/20 animate-pulse"></div>
      </div>
      <h3 className="text-lg font-medium text-foreground">Scraping in progress...</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-[340px] text-center leading-relaxed">
        This can take up to 30 seconds as the API navigates the page, bypasses protections, and extracts structured content.
      </p>
    </div>
  );
}