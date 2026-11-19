/* Strap public storefront bootstrap. The initial HTML is server-rendered for crawlers;
   this script hydrates the buyer experience and connects checkout to the public order API. */
(() => {
  const ctx = window.STRAP_PUBLIC_CONTEXT || {};
  const root = document.getElementById('store-root');
  const slug = String(ctx.slug || '').trim().toLowerCase();
  if (!root || !slug || !window.StrapShop) return;

  const showError = message => {
    root.innerHTML = `<main style="max-width:560px;margin:12vh auto;padding:28px;font:16px/1.5 Inter,system-ui,sans-serif;color:#111">
      <h1 style="font-size:28px;line-height:1.15">This store is temporarily unavailable</h1>
      <p>${String(message || 'Please refresh the page or contact the store owner.').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</p>
      <a href="" style="display:inline-block;margin-top:14px;padding:13px 20px;background:#0a0a0a;color:#e6f53a;border-radius:999px;text-decoration:none;font-weight:700">Refresh store</a>
    </main>`;
  };

  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response, payload;
    try {
      response = await fetch('/api/public/store/' + encodeURIComponent(slug), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal
      });
      payload = await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !payload?.store) throw new Error(payload?.message || 'This store is not published yet.');
    const config = payload.store;
    config.currency = payload.currency || config.currency || 'NGN';
    root.replaceChildren();
    window.StrapShop.open(config, {
      products: Array.isArray(payload.products) ? payload.products : [],
      url: location.host + '/store/' + slug,
      slug,
      live: true,
      standalone: true,
      root,
      productId: ctx.productId || null
    });
  })().catch(error => {
    console.error('Strap storefront could not start:', error);
    showError(error?.name === 'AbortError' ? 'The store took too long to load. Please try again.' : error?.message);
  });
})();
