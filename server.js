import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 8787);
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.types',
  'places.businessStatus',
  'places.regularOpeningHours'
].join(',');

function requireKey(res) {
  if (!GOOGLE_KEY) {
    res.status(500).json({
      error: 'GOOGLE_PLACES_API_KEY is not set on the proxy server.'
    });
    return false;
  }
  return true;
}

function categoryText(category) {
  switch (category) {
    case 'pharmacy':
      return 'eczane';
    case 'market':
      return 'market supermarket grocery';
    case 'cargo':
      return 'kargo cargo courier post office';
    case 'gym':
      return 'spor salonu fitness gym';
    case 'hospital':
      return 'hastane acil servis medical hospital clinic';
    case 'cafe':
      return 'cafe kahve restaurant';
    default:
      return 'place';
  }
}

function suggestedRadius(category) {
  switch (category) {
    case 'pharmacy':
    case 'cargo':
    case 'cafe':
      return 200;
    case 'market':
    case 'gym':
      return 300;
    case 'hospital':
      return 500;
    default:
      return 500;
  }
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
    types.includes('supermarket') ||
    types.includes('grocery_store') ||
    types.includes('convenience_store')
  ) {
    return 'market';
  }

  if (
    primary === 'post_office' ||
    types.includes('post_office') ||
    types.includes('moving_company')
  ) {
    return 'cargo';
  }

  if (
    primary === 'gym' ||
    primary === 'fitness_center' ||
    types.includes('gym') ||
    types.includes('fitness_center')
  ) {
    return 'gym';
  }

  if (
    primary === 'hospital' ||
    primary === 'doctor' ||
    primary === 'medical_lab' ||
    types.includes('hospital') ||
    types.includes('doctor') ||
    types.includes('medical_lab')
  ) {
    return 'hospital';
  }

  if (
    primary === 'cafe' ||
    primary === 'restaurant' ||
    primary === 'coffee_shop' ||
    types.includes('cafe') ||
    types.includes('restaurant') ||
    types.includes('coffee_shop')
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
  const openNow = place.regularOpeningHours?.openNow;

  return {
    externalId: place.id,
    name,
    latitude: lat,
    longitude: lng,
    category,
    address: place.formattedAddress || '',
    distanceMeters: haversineMeters(userLat, userLng, lat, lng),
    openingText:
      typeof openNow === 'boolean' ? (openNow ? 'Açık' : 'Kapalı') : '',
    isOpen: typeof openNow === 'boolean' ? openNow : null,
    suggestedRadiusMeters: suggestedRadius(category),
    source: 'google'
  };
}

function brandQuery(category, brand) {
  if (brand && brand !== 'hepsi' && brand !== 'all') return brand;

  return categoryText(category);
}

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'arrivo-places-proxy' });
});

app.get('/places/search', async (req, res) => {
  if (!requireKey(res)) return;

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const category = String(req.query.category || '').trim();
  const brand = String(req.query.brand || '').trim();
  const q = String(req.query.q || '').trim();
  const radius = Math.min(Number(req.query.radius || 5000), 20000);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: 'lat and lng are required numbers.' });
    return;
  }

  const textQuery = q || brandQuery(category, brand);

  const body = {
    textQuery,
    languageCode: 'tr',
    regionCode: 'TR',
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: {
          latitude: lat,
          longitude: lng
        },
        radius
      }
    }
  };

  try {
    const googleResp = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': FIELD_MASK
        },
        body: JSON.stringify(body)
      }
    );

    const rawText = await googleResp.text();

    if (!googleResp.ok) {
      res.status(googleResp.status).json({
        error: 'Google Places request failed.',
        status: googleResp.status,
        details: rawText
      });
      return;
    }

    const decoded = JSON.parse(rawText);
    const places = decoded.places || [];

    const results = places
      .map((place) => normalizePlace(place, lat, lng, category))
      .filter(Boolean)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    res.json({ results });
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
