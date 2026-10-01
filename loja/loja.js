/**
 * Loja.js - Multi-tenant store initialization
 * Handles URL-based store detection, slug validation, and user session verification
 */

// Load environment variables (development only)
const loadEnv = async () => {
  if (typeof window === 'undefined') {
    try {
      require('dotenv').config();
    } catch (e) {
      console.warn('dotenv not available');
    }
  }
};

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

    // Get store data and user session
    const storeData = await resolveStoreSlugToData(supabaseClient, slug);
    const user = await checkUserSession(supabaseClient);

    // Set ADMIN_LOJA_ID only if user owns the store
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
