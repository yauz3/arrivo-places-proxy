import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 8787);
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 1000 * 60 * 60 * 12);
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 20);
const DAILY_IP_LIMIT = Number(process.env.DAILY_IP_LIMIT || 160);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT || 1500);

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.types',
  'places.businessStatus'
].join(',');

const cache = new Map();
const ipDaily = new Map();
let globalDayKey = dayKey();
let globalDailyCount = 0;

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded() {
  const today = dayKey();
  if (today !== globalDayKey) {
    globalDayKey = today;
    globalDailyCount = 0;
    ipDaily.clear();
  }
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ı', 'i')
    .replaceAll('İ', 'i')
    .replaceAll('ş', 's')
    .replaceAll('Ş', 's')
    .replaceAll('ğ', 'g')
    .replaceAll('Ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('Ü', 'u')
    .replaceAll('ö', 'o')
    .replaceAll('Ö', 'o')
    .replaceAll('ç', 'c')
    .replaceAll('Ç', 'c')
    .replaceAll('’', "'")
    .trim();
}

function roundedCoord(value) {
  return Number(value).toFixed(3);
}

function cacheKey({ lat, lng, category, brand, q, radius }) {
  return [
    roundedCoord(lat),
    roundedCoord(lng),
    category || '',
    normalizeText(brand),
    normalizeText(q),
    Math.round(Number(radius || 10000) / 1000) * 1000
  ].join('|');
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() - item.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCache(key, value) {
  cache.set(key, { time: Date.now(), value });
}

function enforceLimits(req, res) {
  resetDailyIfNeeded();

  if (globalDailyCount >= GLOBAL_DAILY_LIMIT) {
    res.status(429).json({ error: 'Global daily proxy limit reached.' });
    return false;
  }

  const ip = clientIp(req);
  const count = ipDaily.get(ip) || 0;

  if (count >= DAILY_IP_LIMIT) {
    res.status(429).json({ error: 'Daily request limit reached for this client.' });
    return false;
  }

  ipDaily.set(ip, count + 1);
  globalDailyCount += 1;

  return true;
}

function requireKey(res) {
  if (!GOOGLE_KEY) {
    res.status(500).json({
      error: 'GOOGLE_PLACES_API_KEY is not set on the proxy server.'
    });
    return false;
  }
  return true;
}

function includedTypesForCategory(category) {
  switch (category) {
    case 'pharmacy':
      return ['pharmacy'];
    case 'market':
      return ['supermarket', 'grocery_store', 'convenience_store', 'store'];
    case 'cargo':
      return ['post_office'];
    case 'gym':
      return ['gym'];
    case 'hospital':
      return ['hospital', 'doctor'];
    case 'cafe':
      return ['cafe', 'restaurant'];
    default:
      return [];
  }
}

function categoryQueries(category) {
  switch (category) {
    case 'pharmacy':
      return ['eczane', 'nöbetçi eczane', 'pharmacy'];
    case 'market':
      return ['market', 'süpermarket', 'supermarket', 'grocery store', 'bakkal'];
    case 'cargo':
      return ['kargo', 'kargo şubesi', 'courier', 'post office', 'posta'];
    case 'gym':
      return ['spor salonu', 'fitness', 'gym'];
    case 'hospital':
      return ['hastane', 'acil servis', 'hospital', 'clinic'];
    case 'cafe':
      return ['cafe', 'kahve', 'restaurant'];
    default:
      return ['place'];
  }
}

function brandQueries(category, brand) {
  const raw = String(brand || '').trim();
  if (!raw) return categoryQueries(category);

  const n = normalizeText(raw);

  if (category === 'market') {
    const variants = [raw];

    if (n === 'bim' || n === 'bim') variants.push('BIM', 'BİM market', 'BIM market');
    if (n === 'sok') variants.push('ŞOK', 'Şok Market', 'Sok market');
    if (n === 'a101') variants.push('A101 market', 'A 101', 'A101 supermarket');
    if (n === 'migros') variants.push('Migros market', 'Migros supermarket');
    if (n === 'carrefoursa') variants.push('CarrefourSA market', 'Carrefour SA');
    if (n === 'hakmar') variants.push('Hakmar market', 'Hakmar Express');

    variants.push(`${raw} market`, `${raw} süpermarket`, `${raw} supermarket`);
    return [...new Set(variants)];
  }

  if (category === 'cargo') {
    const variants = [raw, `${raw} kargo`, `${raw} cargo`, `${raw} şube`];

    if (n.includes('ptt')) variants.push('PTT', 'PTT Kargo', 'PTT şubesi', 'post office');
    if (n.includes('yurtici')) variants.push('Yurtiçi Kargo', 'Yurtici Kargo');
    if (n.includes('mng')) variants.push('MNG Kargo');
    if (n.includes('aras')) variants.push('Aras Kargo');
    if (n.includes('surat')) variants.push('Sürat Kargo', 'Surat Kargo');
    if (n.includes('sendeo')) variants.push('Sendeo');

    return [...new Set(variants)];
  }

  if (category === 'gym') {
    const variants = [raw, `${raw} gym`, `${raw} fitness`, `${raw} spor salonu`];

    if (n.includes('gold')) variants.push("Gold's Gym", 'Golds Gym');
    if (n.includes('macfit')) variants.push('MacFit', 'MACFit');
    if (n.includes('fitness first')) variants.push('Fitness First');

    return [...new Set(variants)];
  }

  if (category === 'hospital') {
    return [
      raw,
      `${raw} hastane`,
      `${raw} hospital`,
      `${raw} acil`,
      `${raw} acil servis`
    ];
  }

  if (category === 'pharmacy') {
    return [raw, `${raw} eczane`, `${raw} pharmacy`];
  }

  return [raw];
}

function suggestedRadius() {
  return 500;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inferCategory(place, fallbackCategory) {
  const primary = place.primaryType || '';
  const types = place.types || [];

  if (primary === 'pharmacy' || types.includes('pharmacy')) return 'pharmacy';

  if (
    primary === 'supermarket' ||
    primary === 'grocery_store' ||
    primary === 'convenience_store' ||
    primary === 'store' ||
    types.includes('supermarket') ||
    types.includes('grocery_store') ||
    types.includes('convenience_store') ||
    types.includes('store')
  ) {
    return 'market';
  }

  if (primary === 'post_office' || types.includes('post_office')) return 'cargo';
  if (primary === 'gym' || types.includes('gym')) return 'gym';

  if (
    primary === 'hospital' ||
    primary === 'doctor' ||
    types.includes('hospital') ||
    types.includes('doctor')
  ) {
    return 'hospital';
  }

  if (
    primary === 'cafe' ||
    primary === 'restaurant' ||
    types.includes('cafe') ||
    types.includes('restaurant')
  ) {
    return 'cafe';
  }

  return fallbackCategory || 'custom';
}

function normalizePlace(place, userLat, userLng, fallbackCategory) {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const category = inferCategory(place, fallbackCategory);
  const name = place.displayName?.text || 'Unnamed place';

  return {
    externalId: place.id,
    name,
    latitude: lat,
    longitude: lng,
    category,
    address: place.formattedAddress || '',
    distanceMeters: haversineMeters(userLat, userLng, lat, lng),
    openingText: '',
    isOpen: null,
    suggestedRadiusMeters: suggestedRadius(category),
    source: 'google'
  };
}

async function googleNearbySearch({ lat, lng, category, radius }) {
  const includedTypes = includedTypesForCategory(category);

  const body = {
    languageCode: 'tr',
    regionCode: 'TR',
    maxResultCount: MAX_RESULTS,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius
      }
    }
  };

  if (includedTypes.length > 0) {
    body.includedTypes = includedTypes;
  }

  return fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': FIELD_MASK
    },
    body: JSON.stringify(body)
  });
}

async function googleTextSearch({ lat, lng, textQuery, radius, useBias = false }) {
  const circle = {
    center: { latitude: lat, longitude: lng },
    radius
  };

  const body = {
    textQuery,
    languageCode: 'tr',
    regionCode: 'TR',
    maxResultCount: MAX_RESULTS
  };

  if (useBias) {
    body.locationBias = { circle };
  } else {
    body.locationRestriction = { circle };
  }

  return fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': FIELD_MASK
    },
    body: JSON.stringify(body)
  });
}

async function parseGoogleResponse(resp) {
  const rawText = await resp.text();

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: rawText,
      places: []
    };
  }

  const decoded = JSON.parse(rawText);
  return {
    ok: true,
    status: resp.status,
    error: '',
    places: decoded.places || []
  };
}

function uniquePlaces(places) {
  const map = new Map();

  for (const place of places) {
    if (!place || !place.externalId) continue;
    map.set(place.externalId, place);
  }

  return [...map.values()];
}

function matchesBrandSoft(place, brand) {
  if (!brand) return true;

  const p = normalizeText(`${place.name} ${place.address}`);
  const b = normalizeText(brand);

  if (p.includes(b)) return true;

  if (b === 'bim' && (p.includes('bim') || p.includes('bim market'))) return true;
  if (b === 'sok' && (p.includes('sok') || p.includes('şok'))) return true;
  if (b === 'a101' && (p.includes('a101') || p.includes('a 101'))) return true;
  if (b === 'carrefoursa' && (p.includes('carrefour') || p.includes('carrefoursa'))) return true;
  if (b === 'yurtici' && (p.includes('yurtici') || p.includes('yurtiçi'))) return true;
  if (b === 'surat' && (p.includes('surat') || p.includes('sürat'))) return true;

  return false;
}

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    service: 'arrivo-places-proxy',
    cacheSize: cache.size,
    globalDayKey,
    globalDailyCount
  });
});

app.get('/places/search', async (req, res) => {
  if (!requireKey(res)) return;
  if (!enforceLimits(req, res)) return;

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const category = String(req.query.category || '').trim();
  const brand = String(req.query.brand || '').trim();
  const q = String(req.query.q || '').trim();
  const radius = Math.min(Number(req.query.radius || 10000), 10000);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: 'lat and lng are required numbers.' });
    return;
  }

  const key = cacheKey({ lat, lng, category, brand, q, radius });
  const cached = getCache(key);

  if (cached) {
    res.json({ results: cached, cached: true });
    return;
  }

  try {
    const normalizedResults = [];
    let lastError = null;

    const queries = q
      ? [q]
      : brand
        ? brandQueries(category, brand)
        : categoryQueries(category);

    // Kategori seçimi için önce Nearby dene.
    if (!brand && !q) {
      const nearbyParsed = await parseGoogleResponse(
        await googleNearbySearch({ lat, lng, category, radius })
      );

      if (nearbyParsed.ok) {
        for (const place of nearbyParsed.places) {
          const normalized = normalizePlace(place, lat, lng, category);
          if (normalized) normalizedResults.push(normalized);
        }
      } else {
        lastError = {
          status: nearbyParsed.status,
          details: nearbyParsed.error
        };
      }
    }

    // Text Search varyantları.
    for (const queryText of queries) {
      if (normalizedResults.length >= MAX_RESULTS) break;

      for (const useBias of [false, true]) {
        const parsed = await parseGoogleResponse(
          await googleTextSearch({
            lat,
            lng,
            textQuery: queryText,
            radius,
            useBias
          })
        );

        if (!parsed.ok) {
          lastError = {
            status: parsed.status,
            details: parsed.error
          };
          continue;
        }

        for (const place of parsed.places) {
          const normalized = normalizePlace(place, lat, lng, category);
          if (normalized) normalizedResults.push(normalized);
        }

        if (normalizedResults.length > 0) break;
      }

      if (normalizedResults.length > 0) break;
    }

    if (normalizedResults.length === 0 && lastError) {
      res.status(lastError.status).json({
        error: 'Google Places request failed.',
        status: lastError.status,
        details: lastError.details
      });
      return;
    }

    let results = uniquePlaces(normalizedResults)
      .filter((item) => item.distanceMeters <= radius)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    if (brand) {
      const brandMatched = results.filter((item) => matchesBrandSoft(item, brand));

      // Eğer Google marka ismini farklı döndürdüyse tamamen boş bırakmamak için fallback:
      // marka eşleşmesi yoksa yakın sonuçları yine döndür.
      if (brandMatched.length > 0) {
        results = brandMatched;
      }
    }

    results = results.slice(0, MAX_RESULTS);

    setCache(key, results);
    res.json({
      results,
      cached: false,
      debug: {
        category,
        brand,
        q,
        queriesTried: queries
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Proxy search failed.',
      details: String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Arrivo Places Proxy running on port ${PORT}`);
});
