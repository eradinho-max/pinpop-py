// PINPOP • Pins para tus Crocs & Estetoscopio
// MVP Catálogo Visual + WhatsApp Checkout + Mini-ERP Transaccional + Admin Mobile-First

(function() {
  'use strict';

  // --- STATE ---
  let products = [];
  let catalogLoadFailed = false;
  let backendAvailable = true;
  let categories = [];
  let adminCategories = [];
  let productFormGalleryImages = [];
  let productFormOriginalImages = new Set();
  let productFormNewUploads = new Set();
  let settings = {};
  let cart = []; // [{ id, quantity }]
  let currentTargetType = 'crocs'; // 'crocs' or 'estetoscopio'
  let currentCategory = 'Todos';
  let searchQuery = '';
  let onlyInStock = false;
  let onlyFavorites = false;
  let favorites = []; // Array of product ids

  // Admin filter & sort state
  let adminSearchQuery = '';
  let adminLineFilter = 'all'; // 'all', 'crocs', 'estetoscopio'
  let adminStatusFilter = 'all'; // 'all', 'active', 'low', 'out', 'inactive'
  let adminSortBy = 'recent'; // 'recent', 'name_asc', 'price_asc', 'price_desc', 'stock_desc', 'stock_asc', 'sales_desc'

  // Admin session is held in a secure HttpOnly cookie; JS only tracks UI state.
  let authToken = false;
  let adminAuthStage = 'password'; // password | totp | setup
  let pendingSetupPassword = '';
  let adminOrders = [];
  let isUploadingPhoto = false;

  // Modal active product & zoom state
  let modalActiveProduct = null;
  let modalSelectedQty = 1;
  let isZoomActive = false;

  // Stock Adjust Modal State
  let adjustActiveProduct = null;
  let adjustMode = 'entrada'; // 'entrada', 'salida', 'fijo'

  // Simulator state: Crocs (8 holes) & Stethoscope (4 clips)
  let simulatorCurrentView = 'crocs';
  const CROCS_HOLES = [
    { id: 0, top: 22, left: 47 },
    { id: 1, top: 21, left: 54 },
    { id: 2, top: 27, left: 44 },
    { id: 3, top: 27, left: 51 },
    { id: 4, top: 28, left: 58 },
    { id: 5, top: 34, left: 42 },
    { id: 6, top: 34, left: 50 },
    { id: 7, top: 35, left: 57 }
  ];
  let simulatorCrocsSlots = new Array(CROCS_HOLES.length).fill(null);

  const STETH_CLIPS = [
    { id: 0, top: 48, left: 34 },
    { id: 1, top: 58, left: 45 },
    { id: 2, top: 68, left: 55 },
    { id: 3, top: 76, left: 64 }
  ];
  let simulatorStethSlots = new Array(STETH_CLIPS.length).fill(null);

  // --- INIT ---
  document.addEventListener('DOMContentLoaded', async () => {
    loadCartFromStorage();
    loadFavoritesFromStorage();
    await loadSettings();
    await loadCategories();
    await loadProducts();
    setupEventListeners();
    const retryCatalogBtn = document.getElementById('retryCatalogBtn');
    if (retryCatalogBtn) {
      retryCatalogBtn.addEventListener('click', async () => {
        retryCatalogBtn.disabled = true;
        try {
          await loadSettings();
          await loadCategories();
          await loadProducts();
          renderAll();
        } finally {
          retryCatalogBtn.disabled = false;
        }
      });
    }
    initImageZoom();
    initFastAddProductHandlers();
    initStockAdjustHandlers();
    renderAll();
    refreshLucide();

    const initialProductId = new URLSearchParams(window.location.search).get('producto');
    if (initialProductId && products.some(p => p.id === initialProductId)) {
      openProductDetailModal(initialProductId);
    }

    if (window.location.hash === '#admin') {
      openAdminModal();
    }
  });

  function refreshLucide() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // --- STORAGE ---
  function loadCartFromStorage() {
    try {
      const saved = localStorage.getItem('pinpop_cart');
      if (saved) cart = JSON.parse(saved);
    } catch (e) {
      cart = [];
    }
  }

  function saveCartToStorage() {
    localStorage.setItem('pinpop_cart', JSON.stringify(cart));
  }

  function loadFavoritesFromStorage() {
    try {
      const saved = localStorage.getItem('pinpop_favorites');
      if (saved) favorites = JSON.parse(saved);
    } catch (e) {
      favorites = [];
    }
    updateFavoritesBadge();
  }

  function saveFavoritesToStorage() {
    localStorage.setItem('pinpop_favorites', JSON.stringify(favorites));
    updateFavoritesBadge();
  }

  function toggleFavorite(productId) {
    if (favorites.includes(productId)) {
      favorites = favorites.filter(id => id !== productId);
      showToast('Eliminado de tus favoritos', 'info');
    } else {
      favorites.push(productId);
      showToast('¡Guardado en tus favoritos! ❤️', 'success');
    }
    saveFavoritesToStorage();
    renderProducts();
    if (modalActiveProduct && modalActiveProduct.id === productId) {
      updateModalFavoriteButton();
    }
  }

  function updateFavoritesBadge() {
    const badge = document.getElementById('favCountBadge');
    if (!badge) return;
    badge.textContent = favorites.length;
    if (favorites.length > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function getAuthHeaders() {
    return {
      'Content-Type': 'application/json'
    };
  }

  // --- API DATA FETCHING (BACKEND COMO ÚNICA FUENTE DE VERDAD) ---
  async function loadSettings() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Respuesta inválida del servidor.');
      }
      settings = await res.json();
    } catch (err) {
      console.error('API settings no disponible, usando configuración pública de respaldo:', err);
      try {
        const fallbackRes = await fetch('/data/settings-fallback.json', { cache: 'no-store' });
        settings = fallbackRes.ok ? await fallbackRes.json() : {};
      } catch (_) {
        settings = {};
      }
    }
    applySettingsToUI();
  }

  async function loadCategories() {
    try {
      const res = await fetch('/api/categories', { cache: 'no-store' });
      if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Respuesta inválida del servidor.');
      }
      categories = await res.json();
    } catch (err) {
      console.error('API categories no disponible, usando respaldo público:', err);
      try {
        const fallbackRes = await fetch('/data/categories-fallback.json', { cache: 'no-store' });
        categories = fallbackRes.ok ? await fallbackRes.json() : [];
      } catch (_) {
        categories = [];
      }
    }
  }

  async function loadProducts() {
    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Respuesta inválida del servidor.');
      }
      products = await res.json();
      catalogLoadFailed = false;
      backendAvailable = res.headers.get('X-PINPOP-Degraded') !== '1' && res.headers.get('X-PINPOP-Orders-Ready') !== '0';
    } catch (err) {
      console.error('API catálogo no disponible, usando respaldo público de solo lectura:', err);
      backendAvailable = false;
      try {
        const fallbackRes = await fetch('/data/catalog-fallback.json', { cache: 'no-store' });
        if (!fallbackRes.ok) throw new Error('El catálogo de respaldo tampoco respondió.');
        products = await fallbackRes.json();
        catalogLoadFailed = false;
      } catch (fallbackErr) {
        console.error('Error cargando catálogo de respaldo:', fallbackErr);
        products = [];
        catalogLoadFailed = true;
        showToast('No se pudo cargar el catálogo. Intentá nuevamente.', 'error');
      }
    }
    updateTargetTabsCounts();
  }

  function updateTargetTabsCounts() {
    const crocsCount = products.filter(p => (p.targetType || 'crocs') === 'crocs').length;
    const badgeCrocs = document.getElementById('badgeCountCrocs');
    if (badgeCrocs) badgeCrocs.textContent = crocsCount;
  }

  async function verifyActiveSession() {
    try {
      const res = await fetch('/api/auth/session', { headers: getAuthHeaders() });
      if (!res.ok) {
        logoutAdmin(false);
        return;
      }
      showAdminPanel();
      await loadAdminOrders();
      await loadAdminStats();
    } catch (err) {
      console.error('Error verificando sesión administrativa:', err);
      logoutAdmin(false);
      showToast('No se pudo verificar la sesión. Iniciá sesión nuevamente.', 'error');
    }
  }

  function showAdminPanel() {
    const gate = document.getElementById('adminLoginGate');
    const content = document.getElementById('adminContentSection');
    const logoutBtn = document.getElementById('adminLogoutBtn');
    if (gate) gate.classList.add('hidden');
    if (content) content.classList.remove('hidden');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
  }

  function showLoginGate() {
    const gate = document.getElementById('adminLoginGate');
    const content = document.getElementById('adminContentSection');
    const logoutBtn = document.getElementById('adminLogoutBtn');
    if (gate) gate.classList.remove('hidden');
    if (content) content.classList.add('hidden');
    if (logoutBtn) logoutBtn.classList.add('hidden');
  }

  // --- FORMATTING (Guaraníes Gs.) ---
  function formatPrice(amountInGs) {
    const val = Number(amountInGs) || 0;
    return `Gs. ${Math.round(val).toLocaleString('es-PY')}`;
  }

  function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function applySettingsToUI() {
    if (settings.promoBanner) {
      const el = document.getElementById('promoBannerText');
      if (el) el.textContent = settings.promoBanner;
    }
  }

  // --- RENDER FUNCTIONS ---
  function renderAll() {
    renderCategoryChips();
    renderProducts();
    renderCart();
    renderSimulator();
    refreshLucide();
  }

  function switchTargetMode(mode) {
    currentTargetType = mode;
    currentCategory = 'Todos';
    onlyFavorites = false;

    const tabCrocs = document.getElementById('tabModeCrocs');
    const tabSteth = document.getElementById('tabModeEstetoscopio');
    const favNotice = document.getElementById('favoriteFilterNotice');
    if (favNotice) favNotice.classList.add('hidden');

    const heroTag = document.getElementById('heroTargetTag');
    const heroTitle = document.getElementById('heroMainTitle');
    const heroSubtitle = document.getElementById('heroSubtitle');

    if (mode === 'crocs') {
      if (tabCrocs) {
        tabCrocs.className = 'tab-target-btn flex-1 py-2.5 px-3 sm:px-5 rounded-xl font-display font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all bg-[#FF2D8A] text-white shadow-xs';
      }
      if (tabSteth) {
        tabSteth.className = 'tab-target-btn flex-1 py-2.5 px-3 sm:px-5 rounded-xl font-display font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all text-slate-600 hover:text-[#FF2D8A]';
      }
      if (heroTag) heroTag.textContent = '🐊 PINS COMPATIBLES CON CALZADOS CROCS';
      if (heroTitle) heroTitle.textContent = 'Dale onda a tus Crocs ✨';
      if (heroSubtitle) {
        heroSubtitle.innerHTML = 'Elegí tus pins favoritos, armá tu carrito y enviá tu pedido directamente por <strong>WhatsApp</strong> con confirmación rápida y stock en tiempo real en Guaraníes.';
      }
      simulatorCurrentView = 'crocs';
    } else {
      if (tabSteth) {
        tabSteth.className = 'tab-target-btn flex-1 py-2.5 px-3 sm:px-5 rounded-xl font-display font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all bg-[#FF2D8A] text-white shadow-xs';
      }
      if (tabCrocs) {
        tabCrocs.className = 'tab-target-btn flex-1 py-2.5 px-3 sm:px-5 rounded-xl font-display font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all text-slate-600 hover:text-[#FF2D8A]';
      }
      if (heroTag) heroTag.textContent = '🩺 CHARMS Y CLIPS PARA TUBOS DE ESTETOSCOPIO';
      if (heroTitle) heroTitle.textContent = 'Personalizá tu Estetoscopio Clínico 🩺';
      if (heroSubtitle) {
        heroSubtitle.innerHTML = 'Dijes esmaltados y clips en relieve para tubuladuras de estetoscopio (Littmann, MDF, etc.). ¡El detalle distintivo y profesional para tus guardias!';
      }
      simulatorCurrentView = 'estetoscopio';
    }

    renderCategoryChips();
    renderProducts();
    refreshLucide();
  }

  function getActiveCategoriesForCurrentMode() {
    const list = categories
      .filter(c => (c.targetType || 'crocs') === currentTargetType && c.active !== false && Number(c.active ?? 1) !== 0)
      .map(c => c.name);
    return ['Todos', ...list];
  }

  function renderCategoryChips() {
    const container = document.getElementById('categoryChipsContainer');
    if (!container) return;

    const categoriesList = getActiveCategoriesForCurrentMode();

    container.innerHTML = categoriesList.map(cat => {
      const isActive = currentCategory === cat && !onlyFavorites;
      const count = cat === 'Todos' 
        ? products.filter(p => (p.targetType || 'crocs') === currentTargetType).length
        : products.filter(p => (p.targetType || 'crocs') === currentTargetType && p.category === cat).length;

      return `
        <button 
          class="category-chip px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 select-none ${
            isActive 
              ? 'bg-[#FF2D8A] text-white shadow-xs ring-2 ring-[#FF2D8A] ring-offset-1' 
              : 'bg-white hover:bg-[#FFE8F1] text-slate-700 border border-slate-200'
          }"
          data-category="${escapeHtml(cat)}"
        >
          <span>${escapeHtml(cat)}</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-[#111111] text-white' : 'bg-slate-100 text-slate-600'}">
            ${count}
          </span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.category-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        onlyFavorites = false;
        const favNotice = document.getElementById('favoriteFilterNotice');
        if (favNotice) favNotice.classList.add('hidden');
        currentCategory = btn.dataset.category;
        renderCategoryChips();
        renderProducts();
      });
    });
  }

  function renderProducts() {
    const grid = document.getElementById('productGrid');
    const emptyState = document.getElementById('emptyState');
    const errorState = document.getElementById('catalogErrorState');
    const resultsCount = document.getElementById('productResultsCount');
    const activeBadge = document.getElementById('activeCategoryBadge');

    if (catalogLoadFailed) {
      grid.classList.add('hidden');
      if (emptyState) emptyState.classList.add('hidden');
      if (errorState) errorState.classList.remove('hidden');
      if (resultsCount) resultsCount.textContent = 'Catálogo temporalmente no disponible';
      if (activeBadge) activeBadge.classList.add('hidden');
      return;
    }

    if (errorState) errorState.classList.add('hidden');

    let filtered = products.filter(p => {
      if (!p.active) return false;

      // 1. Target type filter
      const pType = p.targetType || 'crocs';
      if (pType !== currentTargetType) return false;

      // 2. Favorites only filter
      if (onlyFavorites && !favorites.includes(p.id)) return false;

      // 3. Category filter
      if (currentCategory !== 'Todos' && p.category !== currentCategory) return false;

      // 4. In stock filter
      if (onlyInStock && (p.stock || 0) <= 0) return false;

      // 5. Search query
      if (searchQuery.trim() !== '') {
        const query = searchQuery.toLowerCase().trim();
        const matchName = (p.name || '').toLowerCase().includes(query);
        const matchSku = (p.sku || '').toLowerCase().includes(query);
        const matchDesc = (p.description || '').toLowerCase().includes(query);
        const matchCat = (p.category || '').toLowerCase().includes(query);
        if (!matchName && !matchSku && !matchDesc && !matchCat) return false;
      }
      return true;
    });

    resultsCount.textContent = `Mostrando ${filtered.length} modelos disponibles`;
    if (currentCategory !== 'Todos' && !onlyFavorites) {
      activeBadge.classList.remove('hidden');
      activeBadge.textContent = currentCategory;
    } else {
      activeBadge.classList.add('hidden');
    }

    if (filtered.length === 0) {
      grid.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }

    grid.classList.remove('hidden');
    emptyState.classList.add('hidden');

    grid.innerHTML = filtered.map(p => {
      const stock = p.stock || 0;
      const isOut = stock <= 0;
      const isLow = stock > 0 && stock <= 3;
      const isFav = favorites.includes(p.id);
      
      const inCartItem = cart.find(i => i.id === p.id);
      const cartQty = inCartItem ? inCartItem.quantity : 0;
      const displayPrice = p.promoPrice ? p.promoPrice : p.price;

      return `
        <div class="product-card bg-white rounded-2xl sm:rounded-3xl border border-slate-200/90 overflow-hidden flex flex-col group relative shadow-xs cursor-pointer select-none" data-id="${escapeHtml(p.id)}">
          
          <!-- Top Badges & Favorite Heart -->
          <div class="absolute top-2 left-2 right-2 flex items-center justify-between z-10 pointer-events-none">
            <div class="flex items-center gap-1">
              <span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-[#111111]/80 text-white backdrop-blur-xs font-mono shadow-xs">
                ${escapeHtml(p.sku || 'PIN')}
              </span>
              ${p.promoPrice ? `
                <span class="badge-oferta px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider shadow-xs">
                  % Oferta
                </span>
              ` : ''}
              ${p.featured ? `
                <span class="px-1.5 py-0.5 rounded-full text-[9px] font-black bg-amber-400 text-slate-900 shadow-xs">
                  ⭐ Top
                </span>
              ` : ''}
            </div>

            <!-- Favorite Heart Button -->
            <button 
              class="btn-card-favorite pointer-events-auto w-7 h-7 rounded-full bg-white/95 backdrop-blur-xs shadow-xs border border-slate-200/80 flex items-center justify-center hover:scale-110 active:scale-95 transition-all text-slate-400 hover:text-[#FF2D8A]" 
              data-id="${escapeHtml(p.id)}" 
              title="Favorito"
            >
              <i data-lucide="heart" class="w-3.5 h-3.5 ${isFav ? 'fill-[#FF2D8A] text-[#FF2D8A]' : ''}"></i>
            </button>
          </div>

          <!-- Product Image Container -->
          <div class="card-trigger relative bg-slate-50 aspect-square p-3 sm:p-4 flex items-center justify-center overflow-hidden border-b border-slate-100 group">
            <img 
              src="${escapeHtml(p.image || '/images/pins/estetoscopio-pin.webp')}" 
              alt="${escapeHtml(p.name)}" 
              class="w-full h-full object-contain filter drop-shadow group-hover:scale-110 transition-transform duration-300"
              loading="lazy"
            />
          </div>

          <!-- Product Details -->
          <div class="p-2.5 sm:p-3.5 flex-1 flex flex-col justify-between">
            <div class="card-trigger">
              <div class="flex items-center justify-between">
                <span class="text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-[#FF2D8A] block truncate max-w-[120px]">
                  ${escapeHtml(p.category)}
                </span>
                ${p.targetType === 'estetoscopio' ? `
                  <span class="text-[9px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded shrink-0">Esteto 🩺</span>
                ` : ''}
              </div>

              <h3 class="font-bold text-[#111111] text-xs sm:text-sm line-clamp-1 group-hover:text-[#FF2D8A] transition-colors mt-0.5" title="${escapeHtml(p.name)}">
                <a class="product-seo-link" href="/producto/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
              </h3>
              
              <!-- Stock Indicator (Brand Style Badges) -->
              <div class="mt-1 flex items-center gap-1.5 text-[10px]">
                ${isOut ? `
                  <span class="badge-agotado px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                    <span>🔴</span> Agotado
                  </span>
                ` : isLow ? `
                  <span class="badge-ultimas px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                    <span>🟡</span> ¡Últimas ${stock}!
                  </span>
                ` : `
                  <span class="badge-disponible px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                    <span>🟢</span> Disponible (${stock})
                  </span>
                `}
              </div>
            </div>

            <!-- Price & Action Button -->
            <div class="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between gap-1">
              <div>
                <span class="text-xs sm:text-sm font-black text-[#111111]">
                  ${formatPrice(displayPrice)}
                </span>
                ${p.promoPrice ? `
                  <span class="text-[10px] text-slate-400 line-through block leading-tight">
                    ${formatPrice(p.price)}
                  </span>
                ` : ''}
              </div>

              ${isOut ? `
                <button 
                  disabled
                  class="px-2 py-1.5 bg-slate-100 text-slate-400 text-[10px] sm:text-xs font-bold rounded-xl cursor-not-allowed"
                >
                  Agotado
                </button>
              ` : `
                <button 
                  class="btn-quick-add px-2.5 sm:px-3 py-1.5 bg-[#FF2D8A] hover:bg-[#E01E75] active:scale-95 text-white text-[10px] sm:text-xs font-black rounded-xl shadow-xs transition-all flex items-center gap-1 shrink-0 ${cartQty >= stock ? 'opacity-60 cursor-not-allowed' : ''}"
                  data-id="${p.id}"
                  ${cartQty >= stock ? 'disabled title="Stock máximo alcanzado"' : ''}
                >
                  <i data-lucide="plus" class="w-3 h-3"></i>
                  <span>${cartQty > 0 ? `(${cartQty})` : 'Agregar'}</span>
                </button>
              `}
            </div>

          </div>

        </div>
      `;
    }).join('');

    grid.querySelectorAll('.product-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-quick-add') || e.target.closest('.btn-card-favorite')) return;
        if (e.target.closest('.product-seo-link')) e.preventDefault();
        openProductDetailModal(card.dataset.id);
      });
    });

    grid.querySelectorAll('.btn-card-favorite').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(btn.dataset.id);
      });
    });

    grid.querySelectorAll('.btn-quick-add').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addToCart(btn.dataset.id, 1);
      });
    });

    refreshLucide();
  }

  // --- INTERACTIVE IMAGE ZOOM LENS (Requerimiento 3) ---
  function initImageZoom() {
    const container = document.getElementById('modalZoomContainer');
    const img = document.getElementById('modalProductImage');
    const mobileToggle = document.getElementById('modalMobileZoomToggle');
    if (!container || !img) return;

    container.addEventListener('mousemove', (e) => {
      const rect = container.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      img.style.transformOrigin = `${x}% ${y}%`;
      img.style.transform = 'scale(2.5)';
      container.classList.add('zoomed');
    });

    container.addEventListener('mouseleave', () => {
      if (!isZoomActive) {
        img.style.transform = 'scale(1)';
        img.style.transformOrigin = 'center center';
        container.classList.remove('zoomed');
      }
    });

    if (mobileToggle) {
      mobileToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        isZoomActive = !isZoomActive;
        if (isZoomActive) {
          img.style.transform = 'scale(2.3)';
          container.classList.add('zoomed');
          showToast('Zoom 2.3x activado', 'info');
        } else {
          img.style.transform = 'scale(1)';
          img.style.transformOrigin = 'center center';
          container.classList.remove('zoomed');
        }
      });
    }
  }

  // --- PRODUCT DETAIL MODAL ---
  function openProductDetailModal(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    modalActiveProduct = product;
    modalSelectedQty = 1;
    isZoomActive = false;

    const modal = document.getElementById('productDetailModal');
    const targetBadge = document.getElementById('modalProductTargetBadge');
    if (targetBadge) {
      targetBadge.textContent = product.targetType === 'estetoscopio' ? '🩺 Estetoscopio' : '🐊 Crocs';
      targetBadge.className = product.targetType === 'estetoscopio' 
        ? 'px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-purple-700 text-white' 
        : 'px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-[#111111] text-white';
    }

    document.getElementById('modalProductSku').textContent = `SKU: ${product.sku || 'PIN'}`;
    const imgEl = document.getElementById('modalProductImage');
    imgEl.src = product.image || '/images/pins/estetoscopio-pin.webp';
    imgEl.alt = product.name || 'Pin PINPOP';
    renderProductGallery(product);
    imgEl.style.transform = 'scale(1)';
    imgEl.style.transformOrigin = 'center center';

    document.getElementById('modalProductCategory').textContent = product.category;
    document.getElementById('modalProductName').textContent = product.name;
    
    const displayPrice = product.promoPrice || product.price;
    document.getElementById('modalProductPrice').textContent = formatPrice(displayPrice);
    
    const promoEl = document.getElementById('modalProductPromoPrice');
    if (product.promoPrice) {
      promoEl.textContent = formatPrice(product.price);
      promoEl.classList.remove('hidden');
    } else {
      promoEl.classList.add('hidden');
    }

    document.getElementById('modalProductDesc').textContent = product.description || 
      (product.targetType === 'estetoscopio' 
        ? 'Dije clip para tubo de estetoscopio fabricado en aleación metálica esmaltada de alta definición.' 
        : 'Pin en relieve de goma suave compatible con calzados tipo Crocs.');

    document.getElementById('modalQtyDisplay').textContent = modalSelectedQty;

    const badgeEl = document.getElementById('modalProductBadge');
    if (product.badge) {
      badgeEl.textContent = product.badge;
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }

    const stock = product.stock || 0;
    const stockContainer = document.getElementById('modalStockContainer');
    const isOut = stock <= 0;
    const isLow = stock > 0 && stock <= 3;

    if (isOut) {
      stockContainer.innerHTML = `<span class="badge-agotado px-2 py-0.5 rounded-full font-black">🔴 Agotado</span> <span class="text-slate-400">• Sin unidades físicas</span>`;
    } else if (isLow) {
      stockContainer.innerHTML = `<span class="badge-ultimas px-2 py-0.5 rounded-full font-black">🟡 ¡Últimas ${stock} unidades disponibles!</span>`;
    } else {
      stockContainer.innerHTML = `<span class="badge-disponible px-2 py-0.5 rounded-full font-bold">🟢 Disponible en Stock:</span> <strong class="text-slate-800 font-black">${stock} unidades</strong>`;
    }

    const addBtn = document.getElementById('modalAddToCartBtn');
    addBtn.disabled = isOut;

    updateModalFavoriteButton();

    modal.classList.remove('hidden');
    refreshLucide();
  }


  function renderProductGallery(product) {
    const container = document.getElementById('modalProductGallery');
    if (!container) return;
    const images = [product.image, ...(Array.isArray(product.galleryImages) ? product.galleryImages : [])]
      .filter(Boolean)
      .filter((url, idx, arr) => arr.indexOf(url) === idx);
    if (images.length <= 1) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }
    container.innerHTML = images.map((url, index) => `
      <button type="button" class="product-gallery-thumb w-14 h-14 shrink-0 rounded-xl border ${index === 0 ? 'border-[#FF2D8A] ring-1 ring-[#FF2D8A]' : 'border-slate-200'} bg-white p-1" data-url="${escapeHtml(url)}">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(product.name)} foto ${index + 1}" class="w-full h-full object-contain rounded-lg">
      </button>`).join('');
    container.classList.remove('hidden');
    container.querySelectorAll('.product-gallery-thumb').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('modalProductImage').src = btn.dataset.url;
        container.querySelectorAll('.product-gallery-thumb').forEach(b => b.className = b.className.replace('border-[#FF2D8A] ring-1 ring-[#FF2D8A]', 'border-slate-200'));
        btn.className = btn.className.replace('border-slate-200', 'border-[#FF2D8A] ring-1 ring-[#FF2D8A]');
      });
    });
  }

  function updateModalFavoriteButton() {
    const btn = document.getElementById('modalFavoriteBtn');
    if (!btn || !modalActiveProduct) return;
    const isFav = favorites.includes(modalActiveProduct.id);
    btn.innerHTML = `
      <i data-lucide="heart" class="w-4 h-4 ${isFav ? 'fill-[#FF2D8A] text-[#FF2D8A]' : ''}"></i>
      <span class="text-[11px] font-medium ${isFav ? 'text-[#FF2D8A] font-bold' : ''}">${isFav ? 'En Favoritos' : 'Favorito'}</span>
    `;
    refreshLucide();
  }

  function closeProductDetailModal() {
    const modal = document.getElementById('productDetailModal');
    if (modal) modal.classList.add('hidden');
    modalActiveProduct = null;
  }

  // --- CART SYSTEM ---
  function addToCart(productId, qty = 1) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const stock = product.stock || 0;
    if (stock <= 0) {
      showToast('Este modelo está agotado.', 'error');
      return;
    }

    const existing = cart.find(i => i.id === productId);
    if (existing) {
      if (existing.quantity + qty > stock) {
        showToast(`Stock máximo disponible: ${stock} un`, 'warning');
        return;
      }
      existing.quantity += qty;
    } else {
      if (qty > stock) {
        showToast(`Stock máximo disponible: ${stock} un`, 'warning');
        return;
      }
      cart.push({ id: productId, quantity: qty });
    }

    saveCartToStorage();
    renderCart();
    renderProducts();
    showToast(`"${product.name}" agregado al carrito 🛒`, 'success');
  }

  function updateCartQuantity(productId, newQty) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    if (newQty <= 0) {
      removeFromCart(productId);
      return;
    }

    const stock = product.stock || 0;
    if (newQty > stock) {
      showToast(`Stock máximo disponible: ${stock} un`, 'warning');
      newQty = stock;
    }

    const item = cart.find(i => i.id === productId);
    if (item) {
      item.quantity = newQty;
      saveCartToStorage();
      renderCart();
      renderProducts();
    }
  }

  function removeFromCart(productId) {
    cart = cart.filter(i => i.id !== productId);
    saveCartToStorage();
    renderCart();
    renderProducts();
    showToast('Pin eliminado del carrito.', 'info');
  }

  function renderCart() {
    const countBadge = document.getElementById('cartCountBadge');
    const drawerBadge = document.getElementById('cartDrawerCountBadge');
    const container = document.getElementById('cartItemsContainer');
    const emptyNotice = document.getElementById('cartEmptyNotice');
    const footerSection = document.getElementById('cartFooterSection');
    const totalText = document.getElementById('cartTotalText');

    const totalCount = cart.reduce((acc, i) => acc + i.quantity, 0);
    if (countBadge) countBadge.textContent = totalCount;
    if (drawerBadge) drawerBadge.textContent = `${totalCount} pins`;

    if (cart.length === 0) {
      if (container) container.innerHTML = '';
      if (emptyNotice) emptyNotice.classList.remove('hidden');
      if (footerSection) footerSection.classList.add('hidden');
      return;
    }

    if (emptyNotice) emptyNotice.classList.add('hidden');
    if (footerSection) footerSection.classList.remove('hidden');

    let subtotal = 0;
    const cartItems = cart.map(item => {
      const p = products.find(prod => prod.id === item.id) || {
        id: item.id,
        name: 'Pin Indisponible',
        price: 0,
        stock: 0,
        image: '/images/pins/estetoscopio-pin.webp'
      };
      const price = p.promoPrice || p.price;
      const lineTotal = price * item.quantity;
      subtotal += lineTotal;
      return { ...item, product: p, price, lineTotal };
    });

    container.innerHTML = `
      <div class="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-xs">
        <table class="w-full text-xs">
          <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-black text-[9px]">
            <tr>
              <th class="p-2.5">Producto</th>
              <th class="p-2.5 text-center">Cant.</th>
              <th class="p-2.5 text-right">Subtotal</th>
              <th class="p-2.5 text-right"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${cartItems.map(item => {
              const p = item.product;
              const isMax = item.quantity >= (p.stock || 0);

              return `
                <tr class="hover:bg-slate-50">
                  <td class="p-2.5">
                    <div class="flex items-center gap-2">
                      <div class="w-9 h-9 rounded-lg bg-slate-100 p-0.5 border border-slate-200 flex items-center justify-center shrink-0">
                        <img src="${escapeHtml(p.image)}" class="w-full h-full object-contain">
                      </div>
                      <div class="min-w-0">
                        <span class="font-bold text-slate-900 block truncate max-w-[130px]">${escapeHtml(p.name)}</span>
                        <span class="text-[10px] text-slate-400 font-mono">${formatPrice(item.price)} un</span>
                      </div>
                    </div>
                  </td>
                  <td class="p-2.5 text-center">
                    <div class="inline-flex items-center border border-slate-300 rounded-lg bg-slate-50 overflow-hidden">
                      <button class="btn-cart-dec px-1.5 py-0.5 text-slate-600 hover:bg-slate-200 font-bold" data-id="${escapeHtml(p.id)}">−</button>
                      <span class="px-2 font-bold text-slate-800">${item.quantity}</span>
                      <button class="btn-cart-inc px-1.5 py-0.5 text-slate-600 hover:bg-slate-200 font-bold ${isMax ? 'opacity-40 cursor-not-allowed' : ''}" data-id="${escapeHtml(p.id)}" ${isMax ? 'disabled' : ''}>+</button>
                    </div>
                  </td>
                  <td class="p-2.5 text-right font-black text-slate-900">
                    ${formatPrice(item.lineTotal)}
                  </td>
                  <td class="p-2.5 text-right">
                    <button class="btn-cart-remove text-slate-400 hover:text-rose-600 p-1" data-id="${escapeHtml(p.id)}">
                      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    if (totalText) totalText.textContent = formatPrice(subtotal);

    container.querySelectorAll('.btn-cart-dec').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const cur = cart.find(i => i.id === id);
        if (cur) updateCartQuantity(id, cur.quantity - 1);
      });
    });

    container.querySelectorAll('.btn-cart-inc').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const cur = cart.find(i => i.id === id);
        if (cur) updateCartQuantity(id, cur.quantity + 1);
      });
    });

    container.querySelectorAll('.btn-cart-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        removeFromCart(btn.dataset.id);
      });
    });

    refreshLucide();
  }

  function openCartDrawer() {
    const drawer = document.getElementById('cartDrawer');
    if (drawer) drawer.classList.remove('hidden');
    renderCart();
    refreshLucide();
  }

  function closeCartDrawer() {
    const drawer = document.getElementById('cartDrawer');
    if (drawer) drawer.classList.add('hidden');
  }

  // --- CHECKOUT & WHATSAPP ---
  function openCheckoutModal() {
    if (cart.length === 0) {
      showToast('Tu carrito está vacío.', 'warning');
      return;
    }

    const modal = document.getElementById('checkoutModal');
    let subtotal = 0;
    cart.forEach(item => {
      const p = products.find(prod => prod.id === item.id);
      if (p) {
        const price = p.promoPrice || p.price;
        subtotal += price * item.quantity;
      }
    });

    const deliveryChoice = document.querySelector('input[name="deliveryChoice"]:checked')?.value || 'delivery';
    const deliveryFeeDefault = settings.deliveryFee || 15000;
    const freeThreshold = settings.freeDeliveryThreshold || 100000;
    
    let fee = 0;
    if (deliveryChoice === 'delivery') {
      fee = subtotal >= freeThreshold ? 0 : deliveryFeeDefault;
    }

    const total = subtotal + fee;

    document.getElementById('checkoutSubtotalText').textContent = formatPrice(subtotal);
    document.getElementById('checkoutDeliveryText').textContent = fee === 0 ? '¡GRATIS!' : formatPrice(fee);
    document.getElementById('checkoutTotalText').textContent = formatPrice(total);

    const addrContainer = document.getElementById('addressFieldContainer');
    const addrInput = document.getElementById('customerAddressInput');
    if (deliveryChoice === 'pickup') {
      if (addrContainer) addrContainer.classList.add('hidden');
      if (addrInput) addrInput.required = false;
    } else {
      if (addrContainer) addrContainer.classList.remove('hidden');
      if (addrInput) addrInput.required = true;
    }

    if (modal) modal.classList.remove('hidden');
    refreshLucide();
  }

  function closeCheckoutModal() {
    const modal = document.getElementById('checkoutModal');
    if (modal) modal.classList.add('hidden');
  }

  async function handleCheckoutSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('customerNameInput').value.trim();
    const phone = document.getElementById('customerPhoneInput').value.trim();
    const address = document.getElementById('customerAddressInput')?.value.trim() || '';
    const paymentMethod = document.getElementById('customerPaymentInput').value;
    const notes = document.getElementById('customerNotesInput').value.trim();
    const deliveryChoice = document.querySelector('input[name="deliveryChoice"]:checked')?.value || 'delivery';

    if (!name || !phone) {
      showToast('Por favor completá tu nombre y celular.', 'warning');
      return;
    }

    if (!backendAvailable) {
      showToast('El catálogo está visible, pero los pedidos están temporalmente fuera de servicio. Intentá nuevamente en unos minutos.', 'warning');
      return;
    }

    const payload = {
      customer: {
        name,
        phone,
        deliveryType: deliveryChoice,
        address: deliveryChoice === 'delivery' ? address : 'Retiro en Local',
        paymentMethod,
        notes
      },
      items: cart.map(item => ({
        productId: item.id,
        quantity: item.quantity
      }))
    };

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = res.headers.get('content-type')?.includes('application/json')
        ? await res.json()
        : null;

      if (!res.ok) {
        throw new Error(data?.error || 'No se pudo crear el pedido.');
      }

      if (!data?.order?.id || !data?.whatsappUrl) {
        throw new Error('El servidor devolvió un pedido incompleto.');
      }

      cart = [];
      saveCartToStorage();
      renderCart();
      renderProducts();

      closeCheckoutModal();
      closeCartDrawer();

      showOrderSuccess(data.order.id, data.whatsappUrl);
      window.open(data.whatsappUrl, '_blank');
    } catch (err) {
      console.error('Error creando pedido:', err);
      showToast(err.message || 'No se pudo crear el pedido. Intentá nuevamente.', 'error');
    }
  }

  function showOrderSuccess(orderId, whatsappUrl) {
    const modal = document.getElementById('orderSuccessModal');
    const codeEl = document.getElementById('successOrderCode');
    const linkEl = document.getElementById('manualWhatsAppLink');

    if (codeEl) codeEl.textContent = '#' + orderId;
    if (linkEl) linkEl.href = whatsappUrl;
    if (modal) modal.classList.remove('hidden');
    refreshLucide();
  }

  // --- DUAL INTERACTIVE SIMULATOR ---
  function openSimulatorModal() {
    const modal = document.getElementById('simulatorModal');
    if (modal) modal.classList.remove('hidden');
    renderSimulator();
    refreshLucide();
  }

  function closeSimulatorModal() {
    const modal = document.getElementById('simulatorModal');
    if (modal) modal.classList.add('hidden');
  }

  function switchSimulatorView(view) {
    simulatorCurrentView = view;
    const btnCrocs = document.getElementById('simSwitchCrocsBtn');
    const btnSteth = document.getElementById('simSwitchStethBtn');
    const viewCrocs = document.getElementById('simCrocsView');
    const viewSteth = document.getElementById('simStethView');

    if (view === 'crocs') {
      if (btnCrocs) btnCrocs.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-[#FF2D8A] text-white';
      if (btnSteth) btnSteth.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all text-slate-600 hover:text-[#FF2D8A]';
      if (viewCrocs) viewCrocs.classList.remove('hidden');
      if (viewSteth) viewSteth.classList.add('hidden');
    } else {
      if (btnSteth) btnSteth.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-[#FF2D8A] text-white';
      if (btnCrocs) btnCrocs.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all text-slate-600 hover:text-[#FF2D8A]';
      if (viewSteth) viewSteth.classList.remove('hidden');
      if (viewCrocs) viewCrocs.classList.add('hidden');
    }

    renderSimulator();
  }

  function renderSimulator() {
    if (simulatorCurrentView === 'crocs') {
      renderCrocsHoles();
    } else {
      renderStethClips();
    }
    renderSimulatorTray();
  }

  function renderCrocsHoles() {
    const container = document.getElementById('crocsHolesContainer');
    if (!container) return;

    container.innerHTML = CROCS_HOLES.map((hole, index) => {
      const pin = simulatorCrocsSlots[index];
      const isOccupied = pin !== null;

      return `
        <div 
          class="clog-hole-slot ${isOccupied ? 'occupied' : 'empty'}"
          style="top: ${hole.top}%; left: ${hole.left}%;"
          data-slot="${index}"
          title="${isOccupied ? `${pin.name} (Clic para quitar)` : 'Hueco libre'}"
        >
          ${isOccupied ? `
            <img src="${escapeHtml(pin.image)}" alt="${escapeHtml(pin.name)}">
          ` : `
            <span class="w-2 h-2 rounded-full bg-[#FF2D8A]/50"></span>
          `}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.clog-hole-slot').forEach(slotEl => {
      slotEl.addEventListener('click', () => {
        const slotIdx = Number(slotEl.dataset.slot);
        if (simulatorCrocsSlots[slotIdx]) {
          const removed = simulatorCrocsSlots[slotIdx].name;
          simulatorCrocsSlots[slotIdx] = null;
          renderCrocsHoles();
          showToast(`Pin ${removed} quitado.`, 'info');
        }
      });
    });

    updateSimulatorSummary();
  }

  function renderStethClips() {
    const container = document.getElementById('stethClipsContainer');
    if (!container) return;

    container.innerHTML = STETH_CLIPS.map((clip, index) => {
      const pin = simulatorStethSlots[index];
      const isOccupied = pin !== null;

      return `
        <div 
          class="steth-clip-slot ${isOccupied ? 'occupied' : 'empty'}"
          style="top: ${clip.top}%; left: ${clip.left}%;"
          data-slot="${index}"
          title="${isOccupied ? `${pin.name} (Clic para quitar)` : 'Clip de tubo libre'}"
        >
          ${isOccupied ? `
            <img src="${escapeHtml(pin.image)}" alt="${escapeHtml(pin.name)}">
          ` : `
            <span class="text-[10px] font-black text-emerald-700">🩺</span>
          `}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.steth-clip-slot').forEach(slotEl => {
      slotEl.addEventListener('click', () => {
        const slotIdx = Number(slotEl.dataset.slot);
        if (simulatorStethSlots[slotIdx]) {
          const removed = simulatorStethSlots[slotIdx].name;
          simulatorStethSlots[slotIdx] = null;
          renderStethClips();
          showToast(`Dije ${removed} quitado.`, 'info');
        }
      });
    });

    updateSimulatorSummary();
  }

  function addPinToSimulator(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    if (simulatorCurrentView === 'crocs') {
      const emptyIdx = simulatorCrocsSlots.findIndex(s => s === null);
      if (emptyIdx === -1) {
        showToast('El calzado ya está completo (8/8 pins). Quitá uno para colocar este.', 'warning');
        return;
      }
      simulatorCrocsSlots[emptyIdx] = product;
      renderCrocsHoles();
    } else {
      const emptyIdx = simulatorStethSlots.findIndex(s => s === null);
      if (emptyIdx === -1) {
        showToast('El estetoscopio ya tiene todos sus clips ocupados (4/4). Quitá uno para colocar este.', 'warning');
        return;
      }
      simulatorStethSlots[emptyIdx] = product;
      renderStethClips();
    }

    showToast(`"${product.name}" colocado en el simulador ✨`, 'success');
  }

  function renderSimulatorTray() {
    const tray = document.getElementById('simulatorTrayContainer');
    if (!tray) return;

    const trayPins = products.filter(p => (p.targetType || 'crocs') === simulatorCurrentView);

    tray.innerHTML = trayPins.map(p => {
      return `
        <button 
          class="btn-tray-pin p-1.5 bg-white rounded-xl border border-slate-200 hover:border-[#FF2D8A] hover:scale-105 active:scale-95 transition-all flex flex-col items-center justify-center text-center shadow-xs"
          data-id="${escapeHtml(p.id)}"
          title="Colocar ${p.name}"
        >
          <img src="${escapeHtml(p.image)}" class="w-8 h-8 object-contain">
          <span class="text-[9px] font-bold text-slate-800 truncate w-full mt-1 block">${escapeHtml(p.name)}</span>
        </button>
      `;
    }).join('');

    tray.querySelectorAll('.btn-tray-pin').forEach(btn => {
      btn.addEventListener('click', () => {
        addPinToSimulator(btn.dataset.id);
      });
    });
  }

  function updateSimulatorSummary() {
    const badge = document.getElementById('simulatorPinCountBadge');
    if (!badge) return;

    if (simulatorCurrentView === 'crocs') {
      const count = simulatorCrocsSlots.filter(s => s !== null).length;
      badge.textContent = `${count} / ${CROCS_HOLES.length}`;
    } else {
      const count = simulatorStethSlots.filter(s => s !== null).length;
      badge.textContent = `${count} / ${STETH_CLIPS.length}`;
    }
  }

  function clearSimulator() {
    if (simulatorCurrentView === 'crocs') {
      simulatorCrocsSlots.fill(null);
      renderCrocsHoles();
    } else {
      simulatorStethSlots.fill(null);
      renderStethClips();
    }
    showToast('Simulador vaciado.', 'info');
  }

  function addSimulatorSelectionToCart() {
    const slots = simulatorCurrentView === 'crocs' ? simulatorCrocsSlots : simulatorStethSlots;
    const selected = slots.filter(s => s !== null);
    if (selected.length === 0) {
      showToast('No colocaste ningún pin en el simulador.', 'warning');
      return;
    }

    selected.forEach(p => {
      addToCart(p.id, 1);
    });

    closeSimulatorModal();
    openCartDrawer();
    showToast(`¡${selected.length} pines agregados al carrito desde el simulador! 🛒`, 'success');
  }

  // --- CLIENT-SIDE IMAGE COMPRESSION (Secciones 6, 7, 8) ---
  async function compressImageFile(file, maxWidth = 1200, maxHeight = 1200, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          // Proportional resize
          if (width > maxWidth || height > maxHeight) {
            if (width / height > maxWidth / maxHeight) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // WebP with JPEG fallback
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              canvas.toBlob((jpegBlob) => {
                resolve(jpegBlob);
              }, 'image/jpeg', quality);
            }
          }, 'image/webp', quality);
        };
        img.onerror = () => reject(new Error('No se pudo decodificar la imagen'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Error al leer el archivo'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadOptimizedImage(file) {
    const sourceTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!file || !sourceTypes.includes((file.type || '').toLowerCase())) {
      throw new Error('Seleccioná una foto JPG, PNG, WebP, HEIC o HEIF válida.');
    }
    if (file.size > 15 * 1024 * 1024) throw new Error('La foto original supera 15 MB.');
    const origSizeKb = Math.round(file.size / 1024);
    const compressedBlob = await compressImageFile(file, 1200, 1200, 0.82);
    if (!compressedBlob) throw new Error('No se pudo optimizar la imagen.');
    const compSizeKb = Math.round(compressedBlob.size / 1024);
    const formData = new FormData();
    formData.append('image', compressedBlob, 'photo.webp');
    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      body: formData
    });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Sesión administrativa vencida.');
    }
    const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    if (!res.ok || !data?.url) throw new Error(data?.error || 'No se pudo subir la imagen.');
    productFormNewUploads.add(data.url);
    return { url: data.url, origSizeKb, compSizeKb };
  }

  async function deleteManagedUpload(url) {
    if (!url || !authToken) return;
    try {
      const res = await fetch('/api/admin/upload/delete', {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ url })
      });
      if (res.ok) productFormNewUploads.delete(url);
    } catch (_) {
      // La limpieza no debe bloquear el formulario; el backend conserva integridad del producto.
    }
  }

  function setMainProductImage(url) {
    const hidden = document.getElementById('pinImageInput');
    const preview = document.getElementById('prodImagePreviewImg');
    const container = document.getElementById('prodImagePreviewContainer');
    const mockup = document.getElementById('mockupCardImg');
    if (hidden) hidden.value = url || '';
    if (url) {
      if (preview) preview.src = url;
      if (mockup) mockup.src = url;
      if (container) container.classList.remove('hidden');
    } else {
      if (preview) preview.removeAttribute('src');
      if (mockup) mockup.src = '/images/pins/estetoscopio-pin.webp';
      if (container) container.classList.add('hidden');
    }
  }

  function renderAdminGalleryPreview() {
    const container = document.getElementById('adminGalleryPreview');
    const count = document.getElementById('adminGalleryCount');
    if (!container) return;
    productFormGalleryImages = productFormGalleryImages.filter(Boolean).slice(0, 4);
    if (count) count.textContent = `${productFormGalleryImages.length}/4 fotos adicionales`;
    container.innerHTML = productFormGalleryImages.map((url, index) => `
      <div class="relative rounded-xl border border-slate-200 bg-white p-1 aspect-square group">
        <img src="${escapeHtml(url)}" alt="Foto adicional ${index + 1}" class="w-full h-full object-contain rounded-lg">
        <div class="absolute inset-x-1 bottom-1 flex gap-1">
          <button type="button" class="btn-gallery-main flex-1 bg-slate-900/90 text-white text-[8px] font-black rounded px-1 py-1" data-index="${index}">Principal</button>
          <button type="button" class="btn-gallery-remove bg-rose-600 text-white text-[8px] font-black rounded px-1.5 py-1" data-index="${index}" aria-label="Eliminar foto">×</button>
        </div>
      </div>`).join('');

    container.querySelectorAll('.btn-gallery-main').forEach(btn => btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      const selected = productFormGalleryImages[index];
      const currentMain = document.getElementById('pinImageInput').value.trim();
      if (!selected) return;
      productFormGalleryImages.splice(index, 1);
      if (currentMain && currentMain !== selected) productFormGalleryImages.unshift(currentMain);
      productFormGalleryImages = productFormGalleryImages.filter((u, i, arr) => u && u !== selected && arr.indexOf(u) === i).slice(0, 4);
      setMainProductImage(selected);
      renderAdminGalleryPreview();
    }));

    container.querySelectorAll('.btn-gallery-remove').forEach(btn => btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.index);
      const [removed] = productFormGalleryImages.splice(index, 1);
      if (removed && productFormNewUploads.has(removed)) await deleteManagedUpload(removed);
      renderAdminGalleryPreview();
    }));
  }

  async function cleanupUnsavedUploads(keepUrls = []) {
    const keep = new Set(keepUrls.filter(Boolean));
    const pending = [...productFormNewUploads].filter(url => !keep.has(url));
    for (const url of pending) await deleteManagedUpload(url);
  }

  function resetProductImageState(mainImage = '', galleryImages = []) {
    productFormGalleryImages = Array.isArray(galleryImages) ? galleryImages.filter(Boolean).slice(0, 4) : [];
    productFormOriginalImages = new Set([mainImage, ...productFormGalleryImages].filter(Boolean));
    productFormNewUploads = new Set();
    setMainProductImage(mainImage);
    renderAdminGalleryPreview();
  }

  // --- FAST ADD / EDIT PRODUCT SYSTEM (Secciones 1 a 23) ---
  function initFastAddProductHandlers() {
    const cameraInput = document.getElementById('prodCameraInput');
    const galleryInput = document.getElementById('prodGalleryInput');
    const extraImagesInput = document.getElementById('prodExtraImagesInput');
    const addExtraImagesBtn = document.getElementById('btnAddExtraImages');
    const triggerCamBtn = document.getElementById('btnTriggerCamera');
    const triggerGalBtn = document.getElementById('btnTriggerGallery');
    const changePhotoBtn = document.getElementById('btnChangePhoto');
    const removePhotoBtn = document.getElementById('btnRemovePhoto');
    const toggleMoreOptionsBtn = document.getElementById('btnToggleMoreOptions');
    const autoSkuBtn = document.getElementById('btnAutoGenerateSku');
    const quickAddCatBtn = document.getElementById('btnQuickAddCategory');
    const saveAndCreateAnotherBtn = document.getElementById('btnSaveAndCreateAnother');
    const productForm = document.getElementById('productAdminForm');

    // Trigger inputs
    if (triggerCamBtn && cameraInput) {
      triggerCamBtn.addEventListener('click', () => cameraInput.click());
    }
    if (triggerGalBtn && galleryInput) {
      triggerGalBtn.addEventListener('click', () => galleryInput.click());
    }
    if (addExtraImagesBtn && extraImagesInput) {
      addExtraImagesBtn.addEventListener('click', () => extraImagesInput.click());
    }
    if (changePhotoBtn && galleryInput) {
      changePhotoBtn.addEventListener('click', () => galleryInput.click());
    }
    if (removePhotoBtn) {
      removePhotoBtn.addEventListener('click', async () => {
        const current = document.getElementById('pinImageInput').value.trim();
        if (current && productFormNewUploads.has(current)) await deleteManagedUpload(current);
        setMainProductImage('');
        showToast('Foto eliminada del formulario.', 'info');
      });
    }

    // Handle file selection from camera or gallery
    const handleFileChosen = async (file) => {
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        showToast('Por favor seleccioná un archivo de imagen válido (JPG, PNG o WebP).', 'warning');
        return;
      }

      const statusEl = document.getElementById('imageUploadStatus');
      const metaEl = document.getElementById('imageMetaText');
      const previewContainer = document.getElementById('prodImagePreviewContainer');
      const previewImg = document.getElementById('prodImagePreviewImg');
      const mockupImg = document.getElementById('mockupCardImg');
      const saveBtn = document.getElementById('btnSaveProduct');
      const saveAnotherBtn = document.getElementById('btnSaveAndCreateAnother');

      try {
        isUploadingPhoto = true;
        if (saveBtn) saveBtn.disabled = true;
        if (saveAnotherBtn) saveAnotherBtn.disabled = true;

        if (statusEl) {
          statusEl.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-amber-500 animate-ping"></span> <span>Procesando imagen (WebP)...</span>`;
        }

        // 1. Immediate local thumbnail preview
        const localUrl = URL.createObjectURL(file);
        if (previewImg) previewImg.src = localUrl;
        if (mockupImg) mockupImg.src = localUrl;
        if (previewContainer) previewContainer.classList.remove('hidden');

        // 2. Optimizar y persistir la imagen
        const previousMain = document.getElementById('pinImageInput').value.trim();
        const uploaded = await uploadOptimizedImage(file);
        const finalImageUrl = uploaded.url;
        if (previousMain && previousMain !== finalImageUrl && productFormNewUploads.has(previousMain)) {
          await deleteManagedUpload(previousMain);
        }
        setMainProductImage(finalImageUrl);

        if (statusEl) {
          statusEl.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-emerald-500"></span> <span class="text-emerald-700 font-bold">✓ Imagen lista y optimizada (${uploaded.compSizeKb} KB WebP)</span>`;
        }
        if (metaEl) metaEl.textContent = `${uploaded.origSizeKb} KB → ${uploaded.compSizeKb} KB (WebP)`;
        showToast('✓ Foto optimizada y guardada.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
        if (statusEl) {
          statusEl.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-rose-500"></span> <span class="text-rose-600 font-bold">Error al subir foto</span>`;
        }
      } finally {
        isUploadingPhoto = false;
        if (saveBtn) saveBtn.disabled = false;
        if (saveAnotherBtn) saveAnotherBtn.disabled = false;
      }
    };

    if (cameraInput) {
      cameraInput.addEventListener('change', async (e) => {
        await handleFileChosen(e.target.files[0]);
        e.target.value = '';
      });
    }
    if (galleryInput) {
      galleryInput.addEventListener('change', async (e) => {
        await handleFileChosen(e.target.files[0]);
        e.target.value = '';
      });
    }
    if (extraImagesInput) {
      extraImagesInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        const available = Math.max(0, 4 - productFormGalleryImages.length);
        if (!available) {
          showToast('La galería ya tiene 4 fotos adicionales.', 'warning');
          e.target.value = '';
          return;
        }
        isUploadingPhoto = true;
        const saveBtn = document.getElementById('btnSaveProduct');
        const saveAnotherBtn = document.getElementById('btnSaveAndCreateAnother');
        if (saveBtn) saveBtn.disabled = true;
        if (saveAnotherBtn) saveAnotherBtn.disabled = true;
        try {
          for (const file of files.slice(0, available)) {
            const uploaded = await uploadOptimizedImage(file);
            if (!productFormGalleryImages.includes(uploaded.url)) productFormGalleryImages.push(uploaded.url);
            renderAdminGalleryPreview();
          }
          showToast('Fotos adicionales guardadas.', 'success');
        } catch (err) {
          showToast(err.message || 'No se pudieron subir las fotos adicionales.', 'error');
        } finally {
          isUploadingPhoto = false;
          if (saveBtn) saveBtn.disabled = false;
          if (saveAnotherBtn) saveAnotherBtn.disabled = false;
          e.target.value = '';
        }
      });
    }

    // Toggle Más Opciones
    if (toggleMoreOptionsBtn) {
      toggleMoreOptionsBtn.addEventListener('click', () => {
        const content = document.getElementById('moreOptionsContent');
        const chevron = document.getElementById('moreOptionsChevron');
        if (content) {
          content.classList.toggle('hidden');
          if (chevron) {
            chevron.classList.toggle('rotate-180');
          }
        }
      });
    }

    // Auto-generate SKU button
    if (autoSkuBtn) {
      autoSkuBtn.addEventListener('click', () => {
        const cat = document.getElementById('pinCategoryInput')?.value || '';
        const target = document.getElementById('pinTargetTypeInput')?.value || 'crocs';
        let prefix = 'PIN';
        if (target === 'estetoscopio') prefix = 'EST';
        else if (cat) {
          const clean = cat.toUpperCase().replace(/[^A-Z]/g, '');
          if (clean.length >= 3) prefix = clean.substring(0, 3);
        }
        const rand = Math.floor(100 + Math.random() * 900);
        document.getElementById('pinSkuInput').value = `${prefix}-${rand}`;
        showToast(`SKU generado: ${prefix}-${rand}`, 'info');
      });
    }

    // Quick add category inline
    if (quickAddCatBtn) {
      quickAddCatBtn.addEventListener('click', () => {
        openCategoryManagerModal();
      });
    }

    // Live Mockup Card Updates (Section 22)
    const nameIn = document.getElementById('pinNameInput');
    const priceIn = document.getElementById('pinPriceInput');
    const catIn = document.getElementById('pinCategoryInput');
    const stockIn = document.getElementById('pinStockInput');

    if (nameIn) {
      nameIn.addEventListener('input', (e) => {
        document.getElementById('mockupCardName').textContent = e.target.value.trim() || 'Nombre del Pin';
      });
    }
    if (priceIn) {
      priceIn.addEventListener('input', (e) => {
        const val = Number(e.target.value) || 0;
        document.getElementById('mockupCardPrice').textContent = formatPrice(val);
        document.getElementById('pinPriceFormattedLabel').textContent = formatPrice(val);
      });
    }
    if (catIn) {
      catIn.addEventListener('change', (e) => {
        document.getElementById('mockupCardCategory').textContent = e.target.value;
      });
    }
    if (stockIn) {
      stockIn.addEventListener('input', (e) => {
        const s = Number(e.target.value) || 0;
        const el = document.getElementById('mockupCardStock');
        if (s <= 0) {
          el.className = 'badge-agotado px-1.5 py-0.2 rounded-full text-[8px] font-bold';
          el.textContent = '🔴 Agotado';
        } else if (s <= 3) {
          el.className = 'badge-ultimas px-1.5 py-0.2 rounded-full text-[8px] font-bold';
          el.textContent = `🟡 ¡Últimas ${s}!`;
        } else {
          el.className = 'badge-disponible px-1.5 py-0.2 rounded-full text-[8px] font-bold';
          el.textContent = `🟢 Disp. (${s})`;
        }
      });
    }

    // Quick stock chips in modal
    document.querySelectorAll('.btn-stock-quick-add').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = Number(btn.dataset.val) || 0;
        const input = document.getElementById('pinStockInput');
        if (input) {
          const current = Number(input.value) || 0;
          input.value = current + val;
          input.dispatchEvent(new Event('input'));
        }
      });
    });

    // Form submit handlers
    if (productForm) {
      productForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveProductForm(false);
      });
    }

    if (saveAndCreateAnotherBtn) {
      saveAndCreateAnotherBtn.addEventListener('click', () => {
        saveProductForm(true);
      });
    }
  }

  async function saveProductForm(createAnother = false) {
    if (!authToken) return;
    if (isUploadingPhoto) {
      showToast('Por favor aguardá a que la imagen termine de subirse.', 'warning');
      return;
    }

    const editId = document.getElementById('editProductId').value;
    const name = document.getElementById('pinNameInput').value.trim();
    if (!name) {
      showToast('El nombre del producto es obligatorio.', 'warning');
      document.getElementById('pinNameInput').focus();
      return;
    }

    const targetType = document.getElementById('pinTargetTypeInput').value;
    const category = document.getElementById('pinCategoryInput').value.trim();
    const price = Number(document.getElementById('pinPriceInput').value);
    if (isNaN(price) || price < 0) {
      showToast('El precio debe ser un número mayor o igual a 0.', 'warning');
      return;
    }

    const stock = Math.max(0, parseInt(document.getElementById('pinStockInput').value, 10) || 0);
    const sku = document.getElementById('pinSkuInput').value.trim();
    const promoPrice = document.getElementById('pinPromoPriceInput').value ? Number(document.getElementById('pinPromoPriceInput').value) : null;
    const costPrice = Number(document.getElementById('pinCostPriceInput').value) || 0;
    const minStock = Number(document.getElementById('pinMinStockInput').value) || 3;
    const badge = document.getElementById('pinBadgeInput').value.trim();
    const description = document.getElementById('pinDescriptionInput').value.trim();
    const featured = document.getElementById('pinFeaturedInput').checked;
    const active = Number(document.getElementById('pinActiveInput').value);
    const image = document.getElementById('pinImageInput').value.trim();
    if (!image) {
      showToast('La foto principal es obligatoria.', 'warning');
      return;
    }

    const galleryImages = productFormGalleryImages.filter(Boolean).filter(url => url !== image).slice(0, 4);
    const payload = { name, targetType, category, price, stock, sku, promoPrice, costPrice, minStock, badge, description, featured, active, image, galleryImages };

    try {
      const res = await fetch(editId ? `/api/admin/products/${editId}` : '/api/admin/products', {
        method: editId ? 'PUT' : 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      if (res.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo guardar el producto.');

      await cleanupUnsavedUploads([image, ...galleryImages]);
      productFormNewUploads.clear();
      productFormOriginalImages = new Set([image, ...galleryImages]);

      await loadProducts();
      renderProducts();
      await renderAdminProducts();
      await loadAdminStats();

      if (createAnother) {
        showToast('✓ Producto publicado con éxito. Listo para el próximo pin ✨', 'success');

        const keepCategory = document.getElementById('batchKeepCategory').checked;
        const keepPrice = document.getElementById('batchKeepPrice').checked;
        const keepStock = document.getElementById('batchKeepStock').checked;
        const savedCategory = category;
        const savedPrice = price;
        const savedStock = stock;

        document.getElementById('editProductId').value = '';
        document.getElementById('pinNameInput').value = '';
        resetProductImageState('', []);
        document.getElementById('pinSkuInput').value = '';
        document.getElementById('pinDescriptionInput').value = '';
        document.getElementById('pinBadgeInput').value = '';
        document.getElementById('pinPromoPriceInput').value = '';
        document.getElementById('pinCostPriceInput').value = '';
        document.getElementById('pinFeaturedInput').checked = false;
        document.getElementById('prodImagePreviewContainer').classList.add('hidden');
        document.getElementById('mockupCardImg').src = '/images/pins/estetoscopio-pin.webp';
        document.getElementById('mockupCardName').textContent = 'Nombre del Pin';

        if (keepCategory) {
          document.getElementById('pinCategoryInput').value = savedCategory;
          document.getElementById('mockupCardCategory').textContent = savedCategory;
        }
        if (keepPrice) {
          document.getElementById('pinPriceInput').value = savedPrice;
          document.getElementById('mockupCardPrice').textContent = formatPrice(savedPrice);
          document.getElementById('pinPriceFormattedLabel').textContent = formatPrice(savedPrice);
        } else {
          document.getElementById('pinPriceInput').value = '';
          document.getElementById('mockupCardPrice').textContent = 'Gs. 0';
          document.getElementById('pinPriceFormattedLabel').textContent = 'Gs. 0';
        }
        document.getElementById('pinStockInput').disabled = false;
        document.getElementById('pinStockLabel').textContent = 'Stock Físico Inicial *';
    document.getElementById('stockQuickButtons')?.classList.remove('hidden');
        document.getElementById('pinStockInput').value = keepStock ? savedStock : '10';
        document.getElementById('pinNameInput').focus();
      } else {
        closeProductFormModal();
        showToast(editId ? '✓ Pin actualizado con éxito.' : '✓ Producto publicado en el catálogo.', 'success');
      }
    } catch (err) {
      console.error('Error guardando producto:', err);
      showToast(err.message || 'No se pudo guardar el producto. Intentá nuevamente.', 'error');
    }
  }

  // --- DEDICATED STOCK ADJUST MODAL (Sección 24) ---
  function initStockAdjustHandlers() {
    const modal = document.getElementById('stockAdjustModal');
    const form = document.getElementById('stockAdjustForm');
    const closeBtn = document.getElementById('closeStockAdjustModalBtn');
    const reasonSelect = document.getElementById('adjustReasonSelect');
    const customReasonContainer = document.getElementById('adjustCustomReasonContainer');
    const qtyInput = document.getElementById('adjustQuantityInput');

    if (closeBtn) {
      closeBtn.addEventListener('click', closeStockAdjustModal);
    }

    // Reason select toggle custom text
    if (reasonSelect && customReasonContainer) {
      reasonSelect.addEventListener('change', () => {
        if (reasonSelect.value === 'Otro') {
          customReasonContainer.classList.remove('hidden');
          document.getElementById('adjustCustomReasonInput').focus();
        } else {
          customReasonContainer.classList.add('hidden');
        }
      });
    }

    // Mode buttons (+ Entrada, - Salida, Nueva Cantidad)
    document.querySelectorAll('.adjust-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        adjustMode = btn.dataset.mode;
        document.querySelectorAll('.adjust-mode-btn').forEach(b => {
          b.className = 'adjust-mode-btn py-2 text-center rounded-xl font-bold text-xs border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer';
        });
        btn.className = 'adjust-mode-btn py-2 text-center rounded-xl font-bold text-xs border border-emerald-600 bg-emerald-600 text-white shadow-xs cursor-pointer';

        const label = document.getElementById('adjustQuantityLabel');
        if (adjustMode === 'entrada') label.textContent = 'Cantidad a ingresar *';
        else if (adjustMode === 'salida') label.textContent = 'Cantidad a restar *';
        else label.textContent = 'Nueva cantidad exacta de stock *';

        updateProjectedStockPreview();
      });
    });

    // Quick chips
    document.querySelectorAll('.btn-adjust-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = Number(btn.dataset.val) || 0;
        if (qtyInput) {
          if (adjustMode === 'fijo') {
            qtyInput.value = val;
          } else {
            qtyInput.value = (Number(qtyInput.value) || 0) + val;
          }
          updateProjectedStockPreview();
        }
      });
    });

    if (qtyInput) {
      qtyInput.addEventListener('input', updateProjectedStockPreview);
    }

    if (form) {
      form.addEventListener('submit', handleStockAdjustSubmit);
    }
  }

  function updateProjectedStockPreview() {
    if (!adjustActiveProduct) return;
    const current = Number(adjustActiveProduct.stock) || 0;
    const inputVal = Number(document.getElementById('adjustQuantityInput').value) || 0;
    let projected = current;

    if (adjustMode === 'entrada') {
      projected = current + inputVal;
    } else if (adjustMode === 'salida') {
      projected = Math.max(0, current - inputVal);
    } else if (adjustMode === 'fijo') {
      projected = Math.max(0, inputVal);
    }

    const previewEl = document.getElementById('adjustResultText');
    if (previewEl) {
      previewEl.textContent = `${current} → ${projected} un`;
    }
  }

  function openStockAdjustModal(productId) {
    const p = products.find(prod => prod.id === productId);
    if (!p) return;

    adjustActiveProduct = p;
    adjustMode = 'entrada';

    document.getElementById('adjustProductId').value = p.id;
    document.getElementById('adjustProductName').textContent = p.name;
    document.getElementById('adjustProductSku').textContent = p.sku || 'PIN';
    document.getElementById('adjustProductImg').src = p.image || '/images/pins/estetoscopio-pin.webp';
    document.getElementById('adjustCurrentStockBadge').textContent = `Stock actual: ${p.stock || 0} un`;
    document.getElementById('adjustQuantityInput').value = '10';
    document.getElementById('adjustReasonSelect').value = 'Compra proveedor';
    document.getElementById('adjustCustomReasonContainer').classList.add('hidden');

    // Reset mode buttons
    document.querySelectorAll('.adjust-mode-btn').forEach(b => {
      if (b.dataset.mode === 'entrada') {
        b.className = 'adjust-mode-btn py-2 text-center rounded-xl font-bold text-xs border border-emerald-600 bg-emerald-600 text-white shadow-xs cursor-pointer';
      } else {
        b.className = 'adjust-mode-btn py-2 text-center rounded-xl font-bold text-xs border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer';
      }
    });

    updateProjectedStockPreview();

    const modal = document.getElementById('stockAdjustModal');
    if (modal) modal.classList.remove('hidden');
    refreshLucide();
  }

  function closeStockAdjustModal() {
    const modal = document.getElementById('stockAdjustModal');
    if (modal) modal.classList.add('hidden');
    adjustActiveProduct = null;
  }

  async function handleStockAdjustSubmit(e) {
    e.preventDefault();
    if (!authToken || !adjustActiveProduct) return;

    const qty = Number(document.getElementById('adjustQuantityInput').value);
    if (isNaN(qty) || qty < 0) {
      showToast('La cantidad debe ser mayor o igual a 0.', 'warning');
      return;
    }

    const reasonChoice = document.getElementById('adjustReasonSelect').value;
    const customReason = document.getElementById('adjustCustomReasonInput').value.trim();
    const reason = reasonChoice === 'Otro' ? (customReason || 'Ajuste manual') : reasonChoice;

    try {
      const res = await fetch(`/api/admin/products/${adjustActiveProduct.id}/stock`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ type: adjustMode, quantity: qty, reason })
      });

      if (res.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo actualizar el stock.');

      showToast(`✓ Stock de "${adjustActiveProduct.name}" actualizado a ${data?.newStock} un.`, 'success');
      closeStockAdjustModal();

      await loadProducts();
      renderProducts();
      await renderAdminProducts();
      await loadAdminStats();
    } catch (err) {
      console.error('Error ajustando stock:', err);
      showToast(err.message || 'No se pudo actualizar el stock. Intentá nuevamente.', 'error');
    }
  }

  // --- DYNAMIC CATEGORIES MANAGEMENT ---
  async function loadAdminCategories() {
    if (!authToken) return [];
    const res = await fetch('/api/admin/categories', { headers: getAuthHeaders() });
    if (res.status === 401) { handleUnauthorized(); return []; }
    const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    if (!res.ok || !Array.isArray(data)) throw new Error(data?.error || 'No se pudieron cargar las categorías.');
    adminCategories = data;
    return data;
  }

  async function openCategoryManagerModal() {
    try {
      await loadAdminCategories();
      renderAdminCategoriesList();
      const modal = document.getElementById('categoryManagerModal');
      if (modal) modal.classList.remove('hidden');
      refreshLucide();
    } catch (err) {
      showToast(err.message || 'No se pudieron cargar las categorías.', 'error');
    }
  }

  function closeCategoryManagerModal() {
    const modal = document.getElementById('categoryManagerModal');
    if (modal) modal.classList.add('hidden');
  }

  function renderAdminCategoriesList() {
    const container = document.getElementById('adminCategoriesList');
    if (!container) return;
    if (adminCategories.length === 0) {
      container.innerHTML = `<p class="py-3 text-slate-400 text-center">No hay categorías registradas.</p>`;
      return;
    }

    container.innerHTML = adminCategories.map(cat => {
      const active = Boolean(Number(cat.active));
      return `
      <div class="flex items-center justify-between gap-2 p-2 bg-slate-50 rounded-xl border border-slate-200 ${active ? '' : 'opacity-60'}">
        <div class="min-w-0 flex items-center gap-2">
          <span class="text-xs font-bold text-slate-800 truncate">${escapeHtml(cat.name)}</span>
          <span class="text-[9px] font-bold px-1.5 py-0.5 rounded ${cat.targetType === 'estetoscopio' ? 'bg-purple-100 text-purple-700' : 'bg-slate-200 text-slate-600'}">
            ${cat.targetType === 'estetoscopio' ? '🩺 Esteto' : '🐊 Crocs'}
          </span>
          <span class="text-[9px] font-bold ${active ? 'text-emerald-600' : 'text-slate-400'}">${active ? 'Activa' : 'Inactiva'}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button class="btn-edit-cat text-slate-500 hover:text-[#FF2D8A] p-1" data-id="${escapeHtml(cat.id)}" title="Editar categoría"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
          ${active
            ? `<button class="btn-delete-cat text-slate-400 hover:text-rose-600 p-1" data-id="${escapeHtml(cat.id)}" title="Desactivar categoría"><i data-lucide="eye-off" class="w-3.5 h-3.5"></i></button>`
            : `<button class="btn-activate-cat text-slate-400 hover:text-emerald-600 p-1" data-id="${escapeHtml(cat.id)}" title="Reactivar categoría"><i data-lucide="eye" class="w-3.5 h-3.5"></i></button>`}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.btn-edit-cat').forEach(btn => btn.addEventListener('click', async () => {
      const cat = adminCategories.find(c => String(c.id) === String(btn.dataset.id));
      if (!cat) return;
      const newName = prompt('Nombre de la categoría:', cat.name);
      if (newName === null || !newName.trim()) return;
      try {
        const res = await fetch(`/api/admin/categories/${encodeURIComponent(cat.id)}`, {
          method: 'PUT', headers: getAuthHeaders(),
          body: JSON.stringify({ name: newName.trim(), targetType: cat.targetType, active: Boolean(Number(cat.active)) })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo editar la categoría.');
        await Promise.all([loadCategories(), loadAdminCategories()]);
        populateCategoryDropdowns(); renderCategoryChips(); renderAdminCategoriesList();
        showToast('Categoría actualizada.', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    }));

    container.querySelectorAll('.btn-delete-cat').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('¿Deseás desactivar esta categoría? Los productos conservarán su historial.')) return;
      try {
        const res = await fetch(`/api/admin/categories/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo desactivar la categoría.');
        await Promise.all([loadCategories(), loadAdminCategories()]);
        populateCategoryDropdowns(); renderCategoryChips(); renderAdminCategoriesList();
        showToast('Categoría desactivada.', 'info');
      } catch (err) { showToast(err.message, 'error'); }
    }));

    container.querySelectorAll('.btn-activate-cat').forEach(btn => btn.addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/admin/categories/${encodeURIComponent(btn.dataset.id)}/activate`, { method: 'POST', headers: getAuthHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo reactivar la categoría.');
        await Promise.all([loadCategories(), loadAdminCategories()]);
        populateCategoryDropdowns(); renderCategoryChips(); renderAdminCategoriesList();
        showToast('Categoría reactivada.', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    }));
    refreshLucide();
  }

  function populateCategoryDropdowns(selectedVal = null) {
    const catSelect = document.getElementById('pinCategoryInput');
    if (!catSelect) return;
    const currentLine = document.getElementById('pinTargetTypeInput')?.value || 'crocs';
    const list = categories.filter(c => (c.targetType || 'crocs') === currentLine && c.active !== false && Number(c.active ?? 1) !== 0);
    catSelect.innerHTML = list.map(c => `<option value="${escapeHtml(c.name)}" ${selectedVal === c.name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    if (list.length === 0) catSelect.innerHTML = `<option value="General">General</option>`;
  }

  async function handleNewCategorySubmit(e) {
    e.preventDefault();
    if (!authToken) return;
    const name = document.getElementById('newCatNameInput').value.trim();
    const targetType = document.getElementById('newCatLineInput').value;
    if (!name) { showToast('Por favor escribí el nombre de la categoría.', 'warning'); return; }
    try {
      const res = await fetch('/api/admin/categories', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ name, targetType }) });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al crear categoría');
      document.getElementById('newCatNameInput').value = '';
      await Promise.all([loadCategories(), loadAdminCategories()]);
      populateCategoryDropdowns(name); renderCategoryChips(); renderAdminCategoriesList();
      showToast(`✓ Categoría "${name}" creada con éxito.`, 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  // --- ADMIN PRODUCTS LIST, SEARCH & FILTERS (Secciones 1, 28, 29) ---
  function openCreateProductModal() {
    document.getElementById('productFormModalTitle').textContent = 'Nuevo Producto';
    document.getElementById('editProductId').value = '';
    resetProductImageState('', []);
    document.getElementById('pinNameInput').value = '';
    document.getElementById('pinPriceInput').value = '';
    document.getElementById('pinStockInput').disabled = false;
    document.getElementById('pinStockInput').value = '10';
    document.getElementById('pinStockLabel').textContent = 'Stock Físico Inicial *';
    document.getElementById('pinSkuInput').value = '';
    document.getElementById('pinPromoPriceInput').value = '';
    document.getElementById('pinCostPriceInput').value = '';
    document.getElementById('pinMinStockInput').value = '3';
    document.getElementById('pinBadgeInput').value = '';
    document.getElementById('pinDescriptionInput').value = '';
    document.getElementById('pinFeaturedInput').checked = false;
    document.getElementById('pinActiveInput').value = '1';
    document.getElementById('pinTargetTypeInput').value = currentTargetType;

    document.getElementById('prodImagePreviewContainer').classList.add('hidden');
    document.getElementById('mockupCardImg').src = '/images/pins/estetoscopio-pin.webp';
    document.getElementById('mockupCardName').textContent = 'Nombre del Pin';
    document.getElementById('mockupCardPrice').textContent = 'Gs. 0';
    document.getElementById('pinPriceFormattedLabel').textContent = 'Gs. 0';

    populateCategoryDropdowns();

    document.getElementById('productFormModal').classList.remove('hidden');
    document.getElementById('pinNameInput').focus();
    refreshLucide();
  }

  function openEditProductModal(productId, allProducts) {
    const p = allProducts.find(item => item.id === productId);
    if (!p) return;

    document.getElementById('productFormModalTitle').textContent = `Editar: ${p.name}`;
    document.getElementById('editProductId').value = p.id;
    document.getElementById('pinTargetTypeInput').value = p.targetType || 'crocs';
    
    populateCategoryDropdowns(p.category);
    document.getElementById('pinCategoryInput').value = p.category || '';

    document.getElementById('pinNameInput').value = p.name || '';
    document.getElementById('pinSkuInput').value = p.sku || '';
    document.getElementById('pinBadgeInput').value = p.badge || '';
    document.getElementById('pinPriceInput').value = p.price || 0;
    document.getElementById('pinPriceFormattedLabel').textContent = formatPrice(p.price || 0);
    document.getElementById('pinPromoPriceInput').value = p.promoPrice || '';
    document.getElementById('pinCostPriceInput').value = p.costPrice || 0;
    document.getElementById('pinStockInput').value = p.stock || 0;
    document.getElementById('pinStockInput').disabled = true;
    document.getElementById('pinStockLabel').textContent = 'Stock actual (usar Ajustar Stock)';
    document.getElementById('stockQuickButtons')?.classList.add('hidden');
    document.getElementById('pinMinStockInput').value = p.minStock || 3;
    resetProductImageState(p.image || '', p.galleryImages || []);
    document.getElementById('pinDescriptionInput').value = p.description || '';
    document.getElementById('pinFeaturedInput').checked = Boolean(p.featured);
    document.getElementById('pinActiveInput').value = p.active ? '1' : '0';

    // Mockup card preview
    document.getElementById('mockupCardImg').src = p.image || '/images/pins/estetoscopio-pin.webp';
    document.getElementById('mockupCardName').textContent = p.name;
    document.getElementById('mockupCardCategory').textContent = p.category;
    document.getElementById('mockupCardPrice').textContent = formatPrice(p.promoPrice || p.price);

    document.getElementById('imageUploadStatus').innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-emerald-500"></span> <span>Foto cargada</span>`;

    document.getElementById('productFormModal').classList.remove('hidden');
    refreshLucide();
  }

  async function closeProductFormModal() {
    await cleanupUnsavedUploads([]);
    productFormNewUploads.clear();
    document.getElementById('productFormModal').classList.add('hidden');
  }

  async function renderAdminProducts() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/products', { headers: getAuthHeaders() });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }

      const adminProducts = res.headers.get('content-type')?.includes('application/json')
        ? await res.json()
        : null;

      if (!res.ok || !Array.isArray(adminProducts)) {
        throw new Error(adminProducts?.error || 'No se pudieron cargar los productos del administrador.');
      }
      
      // Update quick filter counters
      const countAll = adminProducts.length;
      const countActive = adminProducts.filter(p => p.active && (p.stock || 0) > 0).length;
      const countLow = adminProducts.filter(p => p.active && (p.stock || 0) > 0 && (p.stock || 0) <= (p.minStock || 3)).length;
      const countOut = adminProducts.filter(p => p.active && (p.stock || 0) <= 0).length;
      const countInactive = adminProducts.filter(p => !p.active).length;

      if (document.getElementById('countStatusAll')) document.getElementById('countStatusAll').textContent = countAll;
      if (document.getElementById('countStatusActive')) document.getElementById('countStatusActive').textContent = countActive;
      if (document.getElementById('countStatusLow')) document.getElementById('countStatusLow').textContent = countLow;
      if (document.getElementById('countStatusOut')) document.getElementById('countStatusOut').textContent = countOut;
      if (document.getElementById('countStatusInactive')) document.getElementById('countStatusInactive').textContent = countInactive;

      // Filter products
      let list = adminProducts.filter(p => {
        // Line filter
        if (adminLineFilter !== 'all' && (p.targetType || 'crocs') !== adminLineFilter) {
          return false;
        }

        // Status chip filter
        const stock = p.stock || 0;
        const minStock = p.minStock || 3;
        if (adminStatusFilter === 'active' && (!p.active || stock <= 0)) return false;
        if (adminStatusFilter === 'low' && (!p.active || stock <= 0 || stock > minStock)) return false;
        if (adminStatusFilter === 'out' && (!p.active || stock > 0)) return false;
        if (adminStatusFilter === 'inactive' && p.active) return false;

        // Search text
        if (adminSearchQuery) {
          const q = adminSearchQuery.toLowerCase().trim();
          const matchName = (p.name || '').toLowerCase().includes(q);
          const matchSku = (p.sku || '').toLowerCase().includes(q);
          const matchCat = (p.category || '').toLowerCase().includes(q);
          return matchName || matchSku || matchCat;
        }
        return true;
      });

      // Sort products
      if (adminSortBy === 'name_asc') {
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      } else if (adminSortBy === 'price_asc') {
        list.sort((a, b) => (a.price || 0) - (b.price || 0));
      } else if (adminSortBy === 'price_desc') {
        list.sort((a, b) => (b.price || 0) - (a.price || 0));
      } else if (adminSortBy === 'stock_desc') {
        list.sort((a, b) => (b.stock || 0) - (a.stock || 0));
      } else if (adminSortBy === 'stock_asc') {
        list.sort((a, b) => (a.stock || 0) - (b.stock || 0));
      } else if (adminSortBy === 'sales_desc') {
        list.sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0));
      }

      // Update count label
      const countLabel = document.getElementById('adminProductsCountLabel');
      if (countLabel) {
        countLabel.textContent = `Mostrando ${list.length} de ${adminProducts.length} productos`;
      }

      // 1. Render Mobile Cards List
      const mobList = document.getElementById('adminProductsMobileList');
      if (mobList) {
        if (list.length === 0) {
          mobList.innerHTML = `<p class="py-8 text-center text-slate-400 font-bold bg-white rounded-2xl border border-slate-200">No se encontraron productos con estos filtros.</p>`;
        } else {
          mobList.innerHTML = list.map(p => {
            const stock = p.stock || 0;
            const minStock = p.minStock || 3;
            const isOut = stock <= 0;
            const isLow = stock > 0 && stock <= minStock;
            const isActive = p.active !== false;

            return `
              <div class="bg-white rounded-2xl border border-slate-200/90 p-3 space-y-2.5 shadow-xs ${!isActive ? 'opacity-60 bg-slate-50' : ''}">
                <div class="flex items-center gap-3">
                  <div class="w-14 h-14 rounded-xl bg-slate-50 border border-slate-200 p-1 flex items-center justify-center shrink-0">
                    <img src="${escapeHtml(p.image)}" class="w-full h-full object-contain filter drop-shadow-xs">
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="font-mono text-[10px] font-black text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded">${escapeHtml(p.sku || 'PIN')}</span>
                      <span class="text-[10px] font-bold text-[#FF2D8A]">${p.targetType === 'estetoscopio' ? '🩺 Esteto' : '🐊 Crocs'}</span>
                      <span class="text-[10px] text-slate-400">• ${escapeHtml(p.category)}</span>
                    </div>
                    <h4 class="font-bold text-slate-900 text-xs truncate mt-0.5">${escapeHtml(p.name)}</h4>
                    <div class="flex items-center justify-between mt-1">
                      <span class="font-black text-slate-900 text-xs">${formatPrice(p.price)}</span>
                      
                      ${!isActive ? `
                        <span class="px-2 py-0.5 rounded-full text-[9px] font-black bg-slate-200 text-slate-600">Inactivo</span>
                      ` : isOut ? `
                        <span class="px-2 py-0.5 rounded-full text-[9px] font-black bg-rose-100 text-rose-700">🔴 Agotado (0)</span>
                      ` : isLow ? `
                        <span class="px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-100 text-amber-800">🟡 Quedan ${stock}</span>
                      ` : `
                        <span class="px-2 py-0.5 rounded-full text-[9px] font-black bg-emerald-100 text-emerald-800">🟢 Stock: ${stock}</span>
                      `}
                    </div>
                  </div>
                </div>

                <!-- Thumb-friendly mobile action buttons -->
                <div class="grid grid-cols-3 gap-1.5 pt-2 border-t border-slate-100">
                  <button class="btn-admin-edit py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] rounded-xl flex items-center justify-center gap-1" data-id="${escapeHtml(p.id)}">
                    <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
                    <span>Editar</span>
                  </button>
                  <button class="btn-admin-stock py-2 bg-[#FFE8F1] hover:bg-[#FFD4E5] text-[#FF2D8A] font-extrabold text-[11px] rounded-xl flex items-center justify-center gap-1" data-id="${escapeHtml(p.id)}">
                    <i data-lucide="package" class="w-3.5 h-3.5"></i>
                    <span>Stock</span>
                  </button>
                  ${isActive ? `
                    <button class="btn-admin-delete py-2 bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 font-bold text-[11px] rounded-xl flex items-center justify-center gap-1" data-id="${escapeHtml(p.id)}">
                      <i data-lucide="eye-off" class="w-3.5 h-3.5"></i>
                      <span>Ocultar</span>
                    </button>
                  ` : `
                    <button class="btn-admin-activate py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 font-bold text-[11px] rounded-xl flex items-center justify-center gap-1" data-id="${escapeHtml(p.id)}">
                      <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>
                      <span>Activar</span>
                    </button>
                  `}
                </div>
              </div>
            `;
          }).join('');
        }
      }

      // 2. Render Desktop Table
      const tbody = document.getElementById('adminProductsTableBody');
      if (tbody) {
        if (list.length === 0) {
          tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400 font-bold">No se encontraron productos con estos filtros.</td></tr>`;
        } else {
          tbody.innerHTML = list.map(p => {
            const stock = p.stock || 0;
            const minStock = p.minStock || 3;
            const isOut = stock <= 0;
            const isLow = stock > 0 && stock <= minStock;
            const isActive = p.active !== false;

            return `
              <tr class="hover:bg-slate-50 transition-colors ${!isActive ? 'opacity-60 bg-slate-50/50' : ''}">
                <td class="p-2.5">
                  <div class="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 p-0.5 flex items-center justify-center">
                    <img src="${escapeHtml(p.image)}" class="w-full h-full object-contain filter drop-shadow">
                  </div>
                </td>
                <td class="p-2.5 font-mono font-black text-slate-500 text-xs">
                  ${escapeHtml(p.sku || 'PIN')}
                </td>
                <td class="p-2.5">
                  <div class="font-bold text-slate-900">${escapeHtml(p.name)}</div>
                  <div class="text-[10px] text-slate-400">
                    <span class="font-bold text-[#FF2D8A]">${p.targetType === 'estetoscopio' ? '🩺 Esteto' : '🐊 Crocs'}</span> •
                    ${escapeHtml(p.category)} 
                    ${p.badge ? `• <span class="text-amber-600 font-bold">${escapeHtml(p.badge)}</span>` : ''}
                  </div>
                </td>
                <td class="p-2.5 font-black text-slate-900">
                  ${formatPrice(p.price)}
                </td>
                <td class="p-2.5 text-center">
                  <button class="btn-admin-stock px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 font-extrabold text-xs rounded-xl flex items-center gap-1.5 mx-auto" data-id="${escapeHtml(p.id)}">
                    <span>${stock} un</span>
                    <i data-lucide="edit" class="w-3 h-3 text-[#FF2D8A]"></i>
                  </button>
                </td>
                <td class="p-2.5 text-center">
                  ${!isActive ? `
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-200 text-slate-600">Inactivo</span>
                  ` : isOut ? `
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-700">🔴 Agotado</span>
                  ` : isLow ? `
                    <span class="px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-100 text-amber-800">🟡 Stock Bajo</span>
                  ` : `
                    <span class="px-2 py-0.5 rounded-full text-[9px] font-black bg-emerald-100 text-emerald-800">🟢 OK</span>
                  `}
                </td>
                <td class="p-2.5 text-right space-x-1">
                  <button class="btn-admin-edit p-1.5 text-slate-500 hover:text-[#FF2D8A] rounded-lg" data-id="${escapeHtml(p.id)}" title="Editar producto">
                    <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
                  </button>
                  ${isActive ? `
                    <button class="btn-admin-delete p-1.5 text-slate-400 hover:text-rose-600 rounded-lg" data-id="${escapeHtml(p.id)}" title="Desactivar del catálogo">
                      <i data-lucide="eye-off" class="w-3.5 h-3.5"></i>
                    </button>
                  ` : `
                    <button class="btn-admin-activate p-1.5 text-emerald-600 hover:text-emerald-700 rounded-lg" data-id="${escapeHtml(p.id)}" title="Reactivar producto">
                      <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>
                    </button>
                  `}
                </td>
              </tr>
            `;
          }).join('');
        }
      }

      // Bind button events for both Mobile and Desktop
      document.querySelectorAll('.btn-admin-edit').forEach(btn => {
        btn.addEventListener('click', () => openEditProductModal(btn.dataset.id, adminProducts));
      });

      document.querySelectorAll('.btn-admin-stock').forEach(btn => {
        btn.addEventListener('click', () => openStockAdjustModal(btn.dataset.id));
      });

      document.querySelectorAll('.btn-admin-delete').forEach(btn => {
        btn.addEventListener('click', () => deleteProduct(btn.dataset.id));
      });

      document.querySelectorAll('.btn-admin-activate').forEach(btn => {
        btn.addEventListener('click', () => activateProduct(btn.dataset.id));
      });

      refreshLucide();
    } catch (e) {
      console.error(e);
    }
  }

  async function deleteProduct(productId) {
    if (!authToken) return;
    if (!confirm('¿Deseás desactivar este producto del catálogo? (Permanecerá guardado en el sistema)')) return;

    try {
      const res = await fetch(`/api/admin/products/${productId}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo desactivar el producto.');

      showToast('Producto desactivado del catálogo.', 'info');
      await loadProducts();
      renderProducts();
      await renderAdminProducts();
      await loadAdminStats();
    } catch (err) {
      console.error('Error desactivando producto:', err);
      showToast(err.message || 'No se pudo desactivar el producto.', 'error');
    }
  }

  async function activateProduct(productId) {
    if (!authToken) return;

    try {
      const res = await fetch(`/api/admin/products/${productId}/activate`, { method: 'POST', headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo reactivar el producto.');

      showToast('¡Producto reactivado en el catálogo con éxito!', 'success');
      await loadProducts();
      renderProducts();
      await renderAdminProducts();
      await loadAdminStats();
    } catch (err) {
      console.error('Error reactivando producto:', err);
      showToast(err.message || 'No se pudo reactivar el producto.', 'error');
    }
  }

  // --- ADMIN AUTH & CONTROL PANEL ---
  function resetAdmin2faSetupView() {
    pendingSetupPassword = '';
    adminAuthStage = 'password';
    const form = document.getElementById('adminLoginForm');
    const setup = document.getElementById('admin2faSetupSection');
    const setupCode = document.getElementById('admin2faSetupCodeInput');
    const qr = document.getElementById('admin2faQrImage');
    const manual = document.getElementById('admin2faManualKey');
    const openLink = document.getElementById('admin2faOpenLink');
    const password = document.getElementById('adminPasswordInput');
    const totp = document.getElementById('adminTotpInput');
    const title = document.getElementById('adminAuthTitle');
    const description = document.getElementById('adminAuthDescription');
    const submit = document.getElementById('adminLoginSubmitBtn');

    if (form) form.classList.remove('hidden');
    if (setup) setup.classList.add('hidden');
    if (setupCode) setupCode.value = '';
    if (qr) { qr.removeAttribute('src'); qr.classList.add('hidden'); }
    if (manual) manual.textContent = '';
    if (openLink) { openLink.removeAttribute('href'); openLink.classList.add('hidden'); }

    if (password) {
      password.disabled = false;
      password.required = true;
      password.classList.remove('hidden');
      password.value = '';
    }

    if (totp) {
      totp.required = false;
      totp.classList.add('hidden');
      totp.value = '';
    }

    if (title) title.textContent = 'Acceso Administrativo';
    if (description) description.textContent = 'Ingresá tu contraseña para continuar.';
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Continuar';
    }
  }

  function showAdminTotpLoginStep(passwordValue) {
    adminAuthStage = 'totp';
    pendingSetupPassword = passwordValue;

    const title = document.getElementById('adminAuthTitle');
    const description = document.getElementById('adminAuthDescription');
    const password = document.getElementById('adminPasswordInput');
    const totp = document.getElementById('adminTotpInput');
    const submit = document.getElementById('adminLoginSubmitBtn');

    if (title) title.textContent = 'Verificación en dos pasos';
    if (description) description.textContent = 'Abrí tu autenticador e ingresá el código de 6 dígitos.';

    if (password) {
      password.required = false;
      password.disabled = true;
      password.classList.add('hidden');
    }

    if (totp) {
      totp.classList.remove('hidden');
      totp.required = true;
      totp.focus();
    }

    if (submit) submit.textContent = 'Ingresar al Panel';
  }

  function showAdmin2faSetup(data, passwordValue) {
    adminAuthStage = 'setup';
    pendingSetupPassword = passwordValue;

    const form = document.getElementById('adminLoginForm');
    const setup = document.getElementById('admin2faSetupSection');
    const qr = document.getElementById('admin2faQrImage');
    const manual = document.getElementById('admin2faManualKey');
    const openLink = document.getElementById('admin2faOpenLink');

    if (form) form.classList.add('hidden');
    if (setup) setup.classList.remove('hidden');

    if (qr && data.qrDataUrl) {
      qr.src = data.qrDataUrl;
      qr.classList.remove('hidden');
    } else if (qr) {
      qr.removeAttribute('src');
      qr.classList.add('hidden');
    }

    if (manual) manual.textContent = data.manualKey || '';

    if (openLink && data.otpauthUri) {
      openLink.href = data.otpauthUri;
      openLink.classList.remove('hidden');
    }

    const code = document.getElementById('admin2faSetupCodeInput');
    if (code) code.focus();

    showToast(
      data.qrDataUrl
        ? 'Escaneá el QR y confirmá con el código de 6 dígitos.'
        : 'Usá la clave manual o abrí el autenticador para configurar el 2FA.',
      'info'
    );
  }

  async function confirmAdmin2faSetup() {
    const code = document.getElementById('admin2faSetupCodeInput')?.value || '';

    if (!pendingSetupPassword || !/^\d{6}$/.test(code)) {
      showToast('Ingresá el código de 6 dígitos del autenticador.', 'warning');
      return;
    }

    try {
      const res = await fetch('/api/auth/setup/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pendingSetupPassword, totp: code })
      });

      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;

      if (!res.ok || !data?.authenticated) {
        throw new Error(data?.error || 'No se pudo confirmar el 2FA.');
      }

      pendingSetupPassword = '';
      adminAuthStage = 'password';
      authToken = true;
      resetAdmin2faSetupView();
      showAdminPanel();
      await loadAdminOrders();
      await loadAdminStats();
      await renderAdminProducts();
      showToast('2FA configurado. Panel administrativo listo.', 'success');
    } catch (err) {
      console.error('Error confirmando 2FA:', err);
      showToast(err.message || 'No se pudo confirmar el 2FA.', 'error');
    }
  }

  async function handleAdminLogin(e) {
    e.preventDefault();

    if (adminAuthStage === 'totp') {
      const totp = document.getElementById('adminTotpInput')?.value || '';

      if (!pendingSetupPassword || !/^\d{6}$/.test(totp)) {
        showToast('Ingresá el código de 6 dígitos.', 'warning');
        return;
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pendingSetupPassword, totp })
        });

        const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;

        if (!res.ok || !data?.authenticated) {
          throw new Error(data?.error || 'Contraseña o código 2FA incorrecto.');
        }

        authToken = true;
        pendingSetupPassword = '';
        adminAuthStage = 'password';
        resetAdmin2faSetupView();
        showAdminPanel();
        await loadAdminOrders();
        await loadAdminStats();
        await renderAdminProducts();
        showToast('Sesión iniciada con 2FA.', 'success');
      } catch (err) {
        console.error('Error iniciando sesión administrativa:', err);
        showToast(err.message || 'No se pudo iniciar sesión.', 'error');
      }
      return;
    }

    const password = document.getElementById('adminPasswordInput')?.value || '';

    if (!password) {
      showToast('Ingresá la contraseña administrativa.', 'warning');
      return;
    }

    try {
      const res = await fetch('/api/auth/setup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;

      if (!res.ok || !data) {
        throw new Error(data?.error || 'No se pudo validar la contraseña.');
      }

      if (data.totpRequired) {
        showAdminTotpLoginStep(password);
        return;
      }

      if (data.setupRequired && data.manualKey) {
        showAdmin2faSetup(data, password);
        return;
      }

      throw new Error('El servidor no devolvió un estado 2FA válido.');
    } catch (err) {
      console.error('Error iniciando acceso administrativo:', err);
      showToast(err.message || 'No se pudo iniciar el acceso administrativo.', 'error');
    }
  }

  async function logoutAdmin(showMessage = true) {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    authToken = false;
    showLoginGate();
    if (showMessage) showToast('Sesión cerrada.', 'info');
  }

  async function openAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.classList.remove('hidden');
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      authToken = res.ok;
    } catch (_) {
      authToken = false;
    }
    if (authToken) {
      showAdminPanel();
      await loadAdminOrders();
      await loadAdminStats();
      await renderAdminProducts();
    } else {
      showLoginGate();
      resetAdmin2faSetupView();
    }
    refreshLucide();
  }

  function closeAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.classList.add('hidden');
  }

  function handleUnauthorized() {
    logoutAdmin();
    showToast('Sesión expirada. Por favor ingrese nuevamente.', 'warning');
  }

  async function loadAdminOrders() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/orders', { headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok || !Array.isArray(data)) throw new Error(data?.error || 'No se pudieron cargar los pedidos.');
      adminOrders = data;
      renderAdminOrders();
      updatePendingOrdersBadge();
    } catch (err) {
      console.error('Error cargando pedidos administrativos:', err);
      adminOrders = [];
      renderAdminOrders();
      updatePendingOrdersBadge();
      showToast(err.message || 'No se pudieron cargar los pedidos.', 'error');
    }
  }

  async function loadAdminStats() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/stats', { headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok || !data) throw new Error(data?.error || 'No se pudieron cargar las métricas.');
      renderAdminDashboard(data);
    } catch (err) {
      console.error('Error cargando métricas administrativas:', err);
      showToast(err.message || 'No se pudieron cargar las métricas.', 'error');
    }
  }

  function renderAdminDashboard(stats) {
    if (document.getElementById('statTotalProducts')) document.getElementById('statTotalProducts').textContent = stats.totalProducts;
    if (document.getElementById('statTotalStockUnits')) document.getElementById('statTotalStockUnits').textContent = `${stats.totalStockUnits} un`;
    if (document.getElementById('statLowStock')) document.getElementById('statLowStock').textContent = stats.lowStockCount;
    if (document.getElementById('statOutOfStock')) document.getElementById('statOutOfStock').textContent = stats.outOfStockCount;
    if (document.getElementById('statRetailValue')) document.getElementById('statRetailValue').textContent = formatPrice(stats.totalInventoryRetailValue);
    if (document.getElementById('statPotentialProfit')) document.getElementById('statPotentialProfit').textContent = formatPrice(stats.potentialProfit);

    if (document.getElementById('statConversionRate')) document.getElementById('statConversionRate').textContent = `${stats.conversionRate || 0}%`;
    if (document.getElementById('statConversionDetail')) document.getElementById('statConversionDetail').textContent = `${(stats.confirmedOrders || 0) + (stats.deliveredOrders || 0)} confirmados de ${stats.totalOrders || 0} pedidos`;
    if (document.getElementById('statConfirmedRevenue')) document.getElementById('statConfirmedRevenue').textContent = formatPrice(stats.confirmedRevenue || 0);
    if (document.getElementById('statConfirmedCount')) document.getElementById('statConfirmedCount').textContent = `${(stats.confirmedOrders || 0) + (stats.deliveredOrders || 0)} pedidos cobrados`;
    if (document.getElementById('statDeliveredOrders')) document.getElementById('statDeliveredOrders').textContent = stats.deliveredOrders || 0;
    if (document.getElementById('statPendingOrders')) document.getElementById('statPendingOrders').textContent = stats.pendingOrders || 0;

    // Render TOP 10 Best Sellers
    const topListEl = document.getElementById('topSellersList');
    if (topListEl && stats.topSellers) {
      const maxSales = Math.max(...stats.topSellers.map(s => s.salesCount || 1), 1);
      
      topListEl.innerHTML = stats.topSellers.map((item, idx) => {
        const pct = Math.round(((item.salesCount || 0) / maxSales) * 100);
        return `
          <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-200/80 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-5 text-center font-black text-slate-400 text-xs">${idx + 1}.</span>
              <img src="${escapeHtml(item.image)}" class="w-8 h-8 object-contain rounded-lg bg-white p-0.5 border border-slate-200 shrink-0">
              <div class="min-w-0">
                <span class="font-bold text-slate-800 text-xs block truncate">${escapeHtml(item.name)}</span>
                <span class="text-[10px] text-slate-400 font-mono">${escapeHtml(item.sku || 'PIN')} • Stock: ${item.stock} un</span>
              </div>
            </div>

            <div class="flex items-center gap-3 shrink-0 text-right">
              <div class="w-24 hidden sm:block">
                <div class="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                  <div class="bg-[#FF2D8A] h-1.5 rounded-full" style="width: ${pct}%"></div>
                </div>
              </div>
              <span class="px-2 py-0.5 bg-[#FFE8F1] text-[#FF2D8A] font-black rounded-lg text-xs">
                ${item.salesCount || 0} vendidos
              </span>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render Stock Alerts
    const alertsEl = document.getElementById('adminStockAlertsList');
    if (alertsEl) {
      const alertItems = products.filter(p => (p.stock || 0) <= 3);
      if (alertItems.length === 0) {
        alertsEl.innerHTML = `<p class="py-3 text-emerald-600 font-bold">✓ Todo el inventario cuenta con stock suficiente.</p>`;
      } else {
        alertsEl.innerHTML = alertItems.map(p => `
          <div class="py-2 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <img src="${escapeHtml(p.image)}" class="w-7 h-7 object-contain rounded bg-slate-50 p-0.5">
              <div>
                <p class="font-bold text-slate-800 text-xs">${escapeHtml(p.name)}</p>
                <p class="text-[10px] text-slate-400 font-mono">${escapeHtml(p.sku)} • Alerta: stock ≤ 3</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-black ${p.stock <= 0 ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'}">
                ${p.stock <= 0 ? 'Agotado (0)' : `Quedan ${p.stock} un`}
              </span>
              <button class="btn-restock-quick px-2.5 py-1 bg-[#FF2D8A] hover:bg-[#E01E75] text-white font-bold rounded-lg text-[10px]" data-id="${p.id}">
                + Reponer
              </button>
            </div>
          </div>
        `).join('');

        alertsEl.querySelectorAll('.btn-restock-quick').forEach(btn => {
          btn.addEventListener('click', () => {
            openStockAdjustModal(btn.dataset.id);
          });
        });
      }
    }
  }

  function renderAdminOrders() {
    const container = document.getElementById('adminOrdersContainer');
    if (!container) return;

    if (adminOrders.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 bg-white rounded-2xl border border-slate-200 p-6 text-slate-400">
          <p class="font-bold">No hay pedidos registrados todavía.</p>
          <p class="text-xs">Los pedidos generados por WhatsApp aparecerán acá para confirmar y dar baja al stock.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = adminOrders.map(order => {
      const isConfirmed = order.status === 'confirmed';
      const isPending = order.status === 'pending';
      const isDelivered = order.status === 'delivered';
      const isCancelled = order.status === 'cancelled';
      const dateStr = new Date(order.createdAt).toLocaleString('es-PY');

      const rawPhone = (order.customer.phone || '').replace(/\D/g, '');
      const clientWaLink = `https://wa.me/${rawPhone}`;

      return `
        <div class="bg-white rounded-2xl border ${isPending ? 'border-amber-300 ring-2 ring-amber-100' : isDelivered ? 'border-blue-200 bg-blue-50/20' : 'border-slate-200'} p-4 space-y-3">
          
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div class="flex items-center gap-2">
              <span class="font-black text-slate-900 text-sm">#${escapeHtml(order.id)}</span>
              <span class="text-xs text-slate-400">${dateStr}</span>
            </div>

            <div>
              ${isPending ? `
                <span class="px-2.5 py-0.5 rounded-full text-xs font-black bg-amber-100 text-amber-800 flex items-center gap-1">
                  <span>⏳</span> Pendiente en WhatsApp
                </span>
              ` : isConfirmed ? `
                <span class="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-100 text-emerald-800 flex items-center gap-1">
                  <span>✅</span> Confirmado (Stock Descontado)
                </span>
              ` : isDelivered ? `
                <span class="px-2.5 py-0.5 rounded-full text-xs font-black bg-blue-100 text-blue-800 flex items-center gap-1">
                  <span>📦</span> Entregado
                </span>
              ` : `
                <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-500">
                  Cancelado
                </span>
              `}
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-12 gap-3 text-xs">
            <div class="md:col-span-5 bg-slate-50 p-2.5 rounded-xl border border-slate-200/80 space-y-1">
              <div class="font-bold text-slate-800 flex items-center justify-between">
                <span>👤 ${escapeHtml(order.customer.name || 'Cliente')}</span>
                <a href="${clientWaLink}" target="_blank" rel="noopener noreferrer" class="text-[#FF2D8A] hover:text-[#E01E75] font-bold flex items-center gap-1 text-[11px]">
                  <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
                  <span>WhatsApp</span>
                </a>
              </div>
              <div class="text-slate-600 font-mono">📱 ${escapeHtml(order.customer.phone || 'Sin número')}</div>
              <div class="text-slate-600">📍 ${order.customer.deliveryType === 'delivery' ? `Delivery: ${escapeHtml(order.customer.address || '')}` : '🏪 Retiro en Local'}</div>
              ${order.customer.paymentMethod ? `<div class="text-slate-600">💳 ${escapeHtml(order.customer.paymentMethod)}</div>` : ''}
              ${order.customer.notes ? `<div class="text-slate-500 italic mt-1 bg-white p-1 rounded text-[11px] border border-slate-200">📝 "${escapeHtml(order.customer.notes)}"</div>` : ''}
            </div>

            <div class="md:col-span-7 flex flex-col justify-between">
              <div class="space-y-1">
                <span class="text-[10px] font-black uppercase text-slate-400">Detalle de Pins:</span>
                <div class="space-y-1 max-h-28 overflow-y-auto">
                  ${(order.items || []).map(item => `
                    <div class="flex items-center justify-between py-1 px-2 bg-slate-50 rounded-lg">
                      <div class="flex items-center gap-2">
                        <img src="${escapeHtml(item.image)}" class="w-5 h-5 object-contain rounded">
                        <span class="font-bold text-slate-900">${item.quantity}x</span>
                        <span class="text-slate-700 truncate max-w-[170px]">${escapeHtml(item.name)}</span>
                      </div>
                      <span class="font-bold text-slate-800">${formatPrice(item.price * item.quantity)}</span>
                    </div>
                  `).join('')}
                </div>
              </div>

              <div class="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between font-black">
                <span class="text-slate-500">Total:</span>
                <span class="text-sm text-[#FF2D8A]">${formatPrice(order.total)}</span>
              </div>
            </div>
          </div>

          <div class="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
            ${isPending ? `
              <button 
                class="btn-confirm-order-stock px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-black text-xs rounded-xl shadow flex items-center gap-1.5 transition-all"
                data-id="${escapeHtml(order.id)}"
              >
                <i data-lucide="check-circle" class="w-4 h-4"></i>
                <span>Confirmar venta & Descontar Stock</span>
              </button>
            ` : isConfirmed ? `
              <button 
                class="btn-deliver-order px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-black text-xs rounded-xl shadow flex items-center gap-1.5 transition-all"
                data-id="${escapeHtml(order.id)}"
              >
                <i data-lucide="package-check" class="w-4 h-4"></i>
                <span>📦 Marcar como Entregado</span>
              </button>
              <button 
                class="btn-restore-order-stock px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl flex items-center gap-1"
                data-id="${escapeHtml(order.id)}"
              >
                <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>
                <span>Estornar Stock</span>
              </button>
            ` : isDelivered ? `
              <span class="text-xs text-blue-700 font-bold flex items-center gap-1">
                <span>📦</span> Entrega completada
              </span>
            ` : ''}
          </div>

        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-confirm-order-stock').forEach(btn => {
      btn.addEventListener('click', () => confirmOrderStock(btn.dataset.id));
    });

    container.querySelectorAll('.btn-deliver-order').forEach(btn => {
      btn.addEventListener('click', () => deliverOrder(btn.dataset.id));
    });

    container.querySelectorAll('.btn-restore-order-stock').forEach(btn => {
      btn.addEventListener('click', () => restoreOrderStock(btn.dataset.id));
    });

    refreshLucide();
  }

  async function confirmOrderStock(orderId) {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/confirm-stock`, { method: 'POST', headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo confirmar la venta.');
      showToast(`¡Venta #${orderId} confirmada! 🎉`, 'success');
      await loadProducts();
      await loadAdminOrders();
      await loadAdminStats();
      await renderAdminProducts();
    } catch (err) {
      console.error('Error confirmando pedido:', err);
      showToast(err.message || 'No se pudo confirmar la venta.', 'error');
    }
  }

  async function deliverOrder(orderId) {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/deliver`, { method: 'POST', headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo marcar el pedido como entregado.');
      showToast(`¡Pedido #${orderId} marcado como entregado! 📦`, 'success');
      await loadAdminOrders();
      await loadAdminStats();
    } catch (err) {
      console.error('Error marcando pedido como entregado:', err);
      showToast(err.message || 'No se pudo actualizar el pedido.', 'error');
    }
  }

  async function restoreOrderStock(orderId) {
    if (!authToken) return;
    if (!confirm(`¿Deseás anular la venta #${orderId} y devolver los pins al stock?`)) return;
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/restore-stock`, { method: 'POST', headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || 'No se pudo restaurar el stock.');
      showToast(`Stock del pedido #${orderId} restaurado.`, 'info');
      await loadProducts();
      await loadAdminOrders();
      await loadAdminStats();
      await renderAdminProducts();
    } catch (err) {
      console.error('Error restaurando stock:', err);
      showToast(err.message || 'No se pudo restaurar el stock.', 'error');
    }
  }

  function renderStockMovements(movements) {
    const tbody = document.getElementById('adminMovementsTableBody');
    if (!tbody) return;

    if (!movements || movements.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 font-sans">No hay movimientos registrados.</td></tr>`;
      return;
    }

    tbody.innerHTML = movements.map(m => {
      const isEntrada = m.type === 'entrada';
      const isVenta = m.type === 'venta';
      const isEstorno = m.type === 'estorno';
      const dateStr = new Date(m.created_at).toLocaleString('es-PY');

      let typeBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-slate-100 text-slate-600">Ajuste</span>`;
      if (isEntrada) typeBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-emerald-100 text-emerald-800">Entrada</span>`;
      if (isVenta) typeBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-blue-100 text-blue-800">Venta</span>`;
      if (isEstorno) typeBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-amber-100 text-amber-800">Estorno</span>`;

      return `
        <tr class="hover:bg-slate-50">
          <td class="p-2.5 text-slate-500">${dateStr}</td>
          <td class="p-2.5">${typeBadge}</td>
          <td class="p-2.5 font-bold text-slate-800 font-sans">
            ${escapeHtml(m.product_name)} <span class="text-slate-400 font-mono text-[10px]">(${escapeHtml(m.sku || 'PIN')})</span>
          </td>
          <td class="p-2.5 text-center font-bold ${m.quantity > 0 ? 'text-emerald-600' : 'text-rose-600'}">
            ${m.quantity > 0 ? `+${m.quantity}` : m.quantity}
          </td>
          <td class="p-2.5 text-center text-slate-600">
            ${m.prev_stock} → <strong class="text-slate-900">${m.new_stock}</strong>
          </td>
          <td class="p-2.5 text-slate-600 font-sans">
            ${escapeHtml(m.reason)}
          </td>
        </tr>
      `;
    }).join('');
  }

  function updatePendingOrdersBadge() {
    const badge = document.getElementById('pendingOrdersBadge');
    if (!badge) return;
    const pendingCount = adminOrders.filter(o => o.status === 'pending').length;
    badge.textContent = pendingCount;
    if (pendingCount > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // --- SETTINGS FORM ---
  function populateSettingsForm() {
    document.getElementById('settingStoreName').value = settings.storeName || '';
    document.getElementById('settingTagline').value = settings.tagline || '';
    document.getElementById('settingWhatsapp').value = settings.whatsappNumber || '';
    document.getElementById('settingDeliveryFee').value = settings.deliveryFee || 15000;
    document.getElementById('settingFreeThreshold').value = settings.freeDeliveryThreshold || 100000;
    document.getElementById('settingPromoBanner').value = settings.promoBanner || '';
  }

  async function handleSettingsSubmit(e) {
    e.preventDefault();
    if (!authToken) return;

    const payload = {
      storeName: document.getElementById('settingStoreName').value.trim(),
      tagline: document.getElementById('settingTagline').value.trim(),
      whatsappNumber: document.getElementById('settingWhatsapp').value.trim(),
      deliveryFee: Number(document.getElementById('settingDeliveryFee').value) || 15000,
      freeDeliveryThreshold: Number(document.getElementById('settingFreeThreshold').value) || 100000,
      promoBanner: document.getElementById('settingPromoBanner').value.trim()
    };

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      settings = data;
      applySettingsToUI();
      showToast('Configuraciones guardadas.', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }



  // --- TOAST NOTIFICATIONS ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    let bg = 'bg-slate-900 text-white';
    if (type === 'success') bg = 'bg-emerald-600 text-white';
    if (type === 'error') bg = 'bg-rose-600 text-white';
    if (type === 'warning') bg = 'bg-amber-600 text-white';

    toast.className = `${bg} px-4 py-2.5 rounded-2xl shadow-xl text-xs font-bold pointer-events-auto flex items-center gap-2 transform translate-y-4 opacity-0 transition-all duration-200 z-50`;
    toast.textContent = message;

    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-4', 'opacity-0');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    // Mode Switcher (Crocs vs. Estetoscopio)
    const tabCrocs = document.getElementById('tabModeCrocs');
    const tabSteth = document.getElementById('tabModeEstetoscopio');
    if (tabCrocs) tabCrocs.addEventListener('click', () => switchTargetMode('crocs'));
    if (tabSteth) tabSteth.addEventListener('click', () => switchTargetMode('estetoscopio'));

    // Target Type change in product form
    const formTargetSelect = document.getElementById('pinTargetTypeInput');
    if (formTargetSelect) {
      formTargetSelect.addEventListener('change', () => {
        populateCategoryDropdowns();
      });
    }

    // Favorites Wishlist toggle in top header
    const favToggleBtn = document.getElementById('favoritesToggleBtn');
    if (favToggleBtn) {
      favToggleBtn.addEventListener('click', () => {
        onlyFavorites = !onlyFavorites;
        const favNotice = document.getElementById('favoriteFilterNotice');
        if (favNotice) {
          if (onlyFavorites) favNotice.classList.remove('hidden');
          else favNotice.classList.add('hidden');
        }
        renderCategoryChips();
        renderProducts();
      });
    }

    // Modal Favorite heart button
    const modalFavBtn = document.getElementById('modalFavoriteBtn');
    if (modalFavBtn) {
      modalFavBtn.addEventListener('click', () => {
        if (modalActiveProduct) {
          toggleFavorite(modalActiveProduct.id);
        }
      });
    }

    // Search inputs
    const searchDesk = document.getElementById('searchInputDesktop');
    const searchMob = document.getElementById('searchInputMobile');
    const handleSearch = (e) => {
      searchQuery = e.target.value;
      if (searchDesk) searchDesk.value = searchQuery;
      if (searchMob) searchMob.value = searchQuery;
      renderProducts();
    };
    if (searchDesk) searchDesk.addEventListener('input', handleSearch);
    if (searchMob) searchMob.addEventListener('input', handleSearch);

    // Only in Stock checkbox
    const inStockBox = document.getElementById('onlyInStockCheckbox');
    if (inStockBox) {
      inStockBox.addEventListener('change', (e) => {
        onlyInStock = e.target.checked;
        renderProducts();
      });
    }

    // Clear filters button
    const clearBtn = document.getElementById('clearFiltersBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        currentCategory = 'Todos';
        searchQuery = '';
        onlyFavorites = false;
        if (searchDesk) searchDesk.value = '';
        if (searchMob) searchMob.value = '';
        renderCategoryChips();
        renderProducts();
      });
    }

    // Cart buttons
    const cartBtn = document.getElementById('cartButton');
    const closeCart = document.getElementById('closeCartBtn');
    const cartBackdrop = document.getElementById('cartBackdrop');
    const startShop = document.getElementById('startShoppingBtn');
    if (cartBtn) cartBtn.addEventListener('click', openCartDrawer);
    if (closeCart) closeCart.addEventListener('click', closeCartDrawer);
    if (cartBackdrop) cartBackdrop.addEventListener('click', closeCartDrawer);
    if (startShop) startShop.addEventListener('click', closeCartDrawer);

    // Checkout modal triggers
    const proceedBtn = document.getElementById('proceedToCheckoutBtn');
    const closeCheckout = document.getElementById('closeCheckoutBtn');
    const checkoutForm = document.getElementById('checkoutForm');
    if (proceedBtn) proceedBtn.addEventListener('click', openCheckoutModal);
    if (closeCheckout) closeCheckout.addEventListener('click', closeCheckoutModal);
    if (checkoutForm) checkoutForm.addEventListener('submit', handleCheckoutSubmit);

    document.querySelectorAll('input[name="deliveryChoice"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (!document.getElementById('checkoutModal').classList.contains('hidden')) {
          openCheckoutModal();
        }
      });
    });

    // Detail modal
    const closeDetail = document.getElementById('closeProductDetailModalBtn');
    if (closeDetail) closeDetail.addEventListener('click', closeProductDetailModal);

    const qtyDec = document.getElementById('modalQtyDec');
    const qtyInc = document.getElementById('modalQtyInc');
    if (qtyDec) {
      qtyDec.addEventListener('click', () => {
        if (modalSelectedQty > 1) {
          modalSelectedQty--;
          document.getElementById('modalQtyDisplay').textContent = modalSelectedQty;
        }
      });
    }
    if (qtyInc) {
      qtyInc.addEventListener('click', () => {
        if (!modalActiveProduct) return;
        const max = modalActiveProduct.stock || 0;
        if (modalSelectedQty < max) {
          modalSelectedQty++;
          document.getElementById('modalQtyDisplay').textContent = modalSelectedQty;
        } else {
          showToast(`Stock máximo disponible: ${max} un`, 'warning');
        }
      });
    }

    const modalAddBtn = document.getElementById('modalAddToCartBtn');
    if (modalAddBtn) {
      modalAddBtn.addEventListener('click', () => {
        if (modalActiveProduct) {
          addToCart(modalActiveProduct.id, modalSelectedQty);
          closeProductDetailModal();
        }
      });
    }

    // Simulator triggers & switcher
    const openSimBtn = document.getElementById('openSimulatorBtn');
    const closeSimBtn = document.getElementById('closeSimulatorBtn');
    const clearSimBtn = document.getElementById('clearSimulatorClogBtn');
    const addAllSimBtn = document.getElementById('addAllSimulatorPinsToCartBtn');
    const simSwitchCrocs = document.getElementById('simSwitchCrocsBtn');
    const simSwitchSteth = document.getElementById('simSwitchStethBtn');

    if (openSimBtn) openSimBtn.addEventListener('click', openSimulatorModal);
    if (closeSimBtn) closeSimBtn.addEventListener('click', closeSimulatorModal);
    if (clearSimBtn) clearSimBtn.addEventListener('click', clearSimulator);
    if (addAllSimBtn) addAllSimBtn.addEventListener('click', addSimulatorSelectionToCart);
    if (simSwitchCrocs) simSwitchCrocs.addEventListener('click', () => switchSimulatorView('crocs'));
    if (simSwitchSteth) simSwitchSteth.addEventListener('click', () => switchSimulatorView('estetoscopio'));

    // Admin modal triggers
    const openAdmin = document.getElementById('openAdminBtn');
    const closeAdmin = document.getElementById('closeAdminBtn');
    const adminLogout = document.getElementById('adminLogoutBtn');
    const adminForm = document.getElementById('adminLoginForm');
    if (openAdmin) openAdmin.addEventListener('click', openAdminModal);
    if (closeAdmin) closeAdmin.addEventListener('click', closeAdminModal);
    if (adminLogout) adminLogout.addEventListener('click', logoutAdmin);
    if (adminForm) adminForm.addEventListener('submit', handleAdminLogin);
    const admin2faConfirm = document.getElementById('admin2faConfirmBtn');
    const admin2faRestart = document.getElementById('admin2faRestartBtn');
    if (admin2faConfirm) admin2faConfirm.addEventListener('click', confirmAdmin2faSetup);
    if (admin2faRestart) admin2faRestart.addEventListener('click', () => {
      resetAdmin2faSetupView();
    });

    // Admin tabs
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab-btn').forEach(b => {
          b.classList.remove('border-b-2', 'border-[#FF2D8A]', 'text-[#FF2D8A]', 'active');
          b.classList.add('text-slate-600');
        });
        btn.classList.add('border-b-2', 'border-[#FF2D8A]', 'text-[#FF2D8A]', 'active');
        btn.classList.remove('text-slate-600');

        const tab = btn.dataset.tab;
        document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
        
        if (tab === 'dashboard') {
          document.getElementById('adminTabDashboard').classList.remove('hidden');
          loadAdminStats();
        } else if (tab === 'orders') {
          document.getElementById('adminTabOrders').classList.remove('hidden');
          loadAdminOrders();
        } else if (tab === 'products') {
          document.getElementById('adminTabProducts').classList.remove('hidden');
          renderAdminProducts();
        } else if (tab === 'movements') {
          document.getElementById('adminTabMovements').classList.remove('hidden');
          loadStockMovements();
        } else if (tab === 'settings') {
          document.getElementById('adminTabSettings').classList.remove('hidden');
          populateSettingsForm();
        }
        refreshLucide();
      });
    });

    // Admin Product Search, Filter & Sort listeners
    const adminSearch = document.getElementById('adminSearchInput');
    if (adminSearch) {
      adminSearch.addEventListener('input', (e) => {
        adminSearchQuery = e.target.value;
        renderAdminProducts();
      });
    }

    const adminLine = document.getElementById('adminLineFilter');
    if (adminLine) {
      adminLine.addEventListener('change', (e) => {
        adminLineFilter = e.target.value;
        renderAdminProducts();
      });
    }

    const adminSort = document.getElementById('adminSortSelect');
    if (adminSort) {
      adminSort.addEventListener('change', (e) => {
        adminSortBy = e.target.value;
        renderAdminProducts();
      });
    }

    // Status filter chips in Admin
    document.querySelectorAll('.admin-status-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        adminStatusFilter = chip.dataset.status;
        document.querySelectorAll('.admin-status-chip').forEach(c => {
          c.className = 'admin-status-chip px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 cursor-pointer';
        });
        chip.className = 'admin-status-chip px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-[#111111] text-white shadow-xs cursor-pointer';
        renderAdminProducts();
      });
    });

    // Admin modals open/close
    const openCreateProd = document.getElementById('openCreateProductModalBtn');
    const closeCreateProd = document.getElementById('closeProductFormModalBtn');
    if (openCreateProd) openCreateProd.addEventListener('click', openCreateProductModal);
    if (closeCreateProd) closeCreateProd.addEventListener('click', closeProductFormModal);

    // Category Manager modal triggers
    const openCatMgr = document.getElementById('openCategoryManagerBtn');
    const closeCatMgr = document.getElementById('closeCategoryManagerModalBtn');
    const newCatForm = document.getElementById('newCategoryForm');
    if (openCatMgr) openCatMgr.addEventListener('click', openCategoryManagerModal);
    if (closeCatMgr) closeCatMgr.addEventListener('click', closeCategoryManagerModal);
    if (newCatForm) newCatForm.addEventListener('submit', handleNewCategorySubmit);

    // Admin Settings & Password
    const settingsForm = document.getElementById('adminSettingsForm');
    if (settingsForm) settingsForm.addEventListener('submit', handleSettingsSubmit);

    // Movements refresh
    const refreshMov = document.getElementById('refreshMovementsBtn');
    if (refreshMov) refreshMov.addEventListener('click', loadStockMovements);

    // Order Success close
    const closeSuccessBtn = document.getElementById('closeSuccessModalBtn');
    if (closeSuccessBtn) {
      closeSuccessBtn.addEventListener('click', () => {
        document.getElementById('orderSuccessModal').classList.add('hidden');
      });
    }
  }

  async function loadStockMovements() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/stock-movements', { headers: getAuthHeaders() });
      if (res.status === 401) { handleUnauthorized(); return; }
      const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (!res.ok || !Array.isArray(data)) throw new Error(data?.error || 'No se pudieron cargar los movimientos.');
      renderStockMovements(data);
    } catch (err) {
      console.error('Error cargando movimientos de stock:', err);
      renderStockMovements([]);
      showToast(err.message || 'No se pudieron cargar los movimientos de stock.', 'error');
    }
  }

})();
