/**
 * Loja.js - Multi-tenant store initialization
 * Handles URL-based store detection, slug validation, user session verification, and theme application
 */

// Get credentials from environment or window config
const getSupabaseConfig = () => {
  const url =
    (typeof process !== 'undefined' && process.env.VITE_SUPABASE_URL) ||
    window.SUPABASE_CONFIG?.url ||
    'https://qqoepslbisxpswabrkqe.supabase.co';

  const key =
    (typeof process !== 'undefined' && process.env.VITE_SUPABASE_ANON_KEY) ||
    window.SUPABASE_CONFIG?.publishableKey ||
    'sb_publishable_vN1Q4fw4uTm1sflUx8KmCQ_eVrIoCzr';

  return { url, key };
};

/**
 * Extract and validate store slug from URL path (/loja/[slug]/)
 */
function getStoreSlugFromURL() {
  const pathMatch = window.location.pathname.match(/\/loja\/([a-z0-9]+(?:-[a-z0-9]+)*)\//);

  if (pathMatch && pathMatch[1]) {
    return pathMatch[1];
  }

  // Fallback to query string
  const params = new URLSearchParams(window.location.search);
  return params.get('loja') || null;
}

/**
 * Validate slug format to prevent injection attacks
 */
function validateSlugFormat(slug) {
  if (!slug) return false;
  const validPattern = /^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])?$/;
  return validPattern.test(slug);
}

/**
 * Resolve store slug to store data (ID and owner)
 */
async function resolveStoreSlugToData(supabaseClient, storeSlug) {
  const { data, error } = await supabaseClient
    .from('lojas')
    .select('id, user_id')
    .eq('slug', storeSlug)
    .single();

  if (error) {
    console.warn('Store not found:', storeSlug);
    return null;
  }

  return data;
}

/**
 * Check current user session
 */
async function checkUserSession(supabaseClient) {
  const { data: { session }, error } = await supabaseClient.auth.getSession();

  if (error || !session) {
    return null;
  }

  return session.user;
}

/**
 * Validate if user owns the store
 */
function validateStoreOwnership(user, storeData) {
  if (!user || !storeData) return false;
  return user.id === storeData.user_id;
}

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Load and apply store theme from store_settings
 */
async function applyStoreTheme(supabaseClient, storeId) {
  try {
    const { data: settings, error } = await supabaseClient
      .from('store_settings')
      .select('modo, cor_primaria, cor_primaria_clara')
      .eq('loja_id', storeId)
      .single();

    if (error || !settings) {
      console.warn('Store settings not found, using defaults');
      return;
    }

    const html = document.documentElement;

    // Set theme mode
    const theme = settings.modo === 'light' ? 'clean-light' : 'dark-esportivo';
    html.setAttribute('data-theme', theme);

    // Apply custom colors
    if (settings.cor_primaria) {
      // Convert hex to RGB for glow effects
      const rgb = hexToRgb(settings.cor_primaria);
      html.style.setProperty('--gold', settings.cor_primaria);
      html.style.setProperty('--gold-bright', settings.cor_primaria_clara || settings.cor_primaria);
      html.style.setProperty('--gold-text', settings.cor_primaria);
      if (rgb) {
        html.style.setProperty('--gold-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
      }
    }

    console.log('Theme applied:', theme, settings.cor_primaria);
  } catch (error) {
    console.error('Theme loading error:', error);
  }
}

/**
 * Initialize store from URL and set ADMIN_LOJA_ID if user is owner
 */
async function initializeStoreFromURL() {
  try {
    const slug = getStoreSlugFromURL();

    if (!slug || !validateSlugFormat(slug)) {
      console.warn('Invalid or missing store slug');
      return;
    }

    // Initialize Supabase client
    const config = getSupabaseConfig();
    const supabaseClient = window.supabase.createClient(config.url, config.key);

    // Get store data
    const storeData = await resolveStoreSlugToData(supabaseClient, slug);

    if (!storeData) {
      console.warn('Store not found');
      return;
    }

    // Apply store theme from settings
    await applyStoreTheme(supabaseClient, storeData.id);

    // Set ADMIN_LOJA_ID if user owns the store
    const user = await checkUserSession(supabaseClient);
    if (validateStoreOwnership(user, storeData)) {
      window.ADMIN_LOJA_ID = storeData.id;
      console.log('Store owner authenticated:', storeData.id);
    } else {
      console.log('Store catalog is public - no admin access');
    }
  } catch (error) {
    console.error('Store initialization error:', error);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeStoreFromURL);
} else {
  initializeStoreFromURL();
}
