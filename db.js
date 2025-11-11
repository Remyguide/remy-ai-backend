// db.js — carga el JSON y busca restaurantes por cercanía + prestigio
import fs from "fs";

let DATA = [];
try {
  const raw = fs.readFileSync(process.env.REMY_JSON_PATH || "./data/remy_restaurants_compact.json", "utf8");
  DATA = JSON.parse(raw);
  console.log(`Remy DB cargada: ${DATA.length} restaurantes`);
} catch (e) {
  console.warn("No pude cargar la base JSON. ¿Subiste data/remy_restaurants_compact.json?", e.message);
  DATA = [];
}

// Distancia en km (Haversine)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI/180;
  const dlat = toRad(lat2 - lat1), dlon = toRad(lon2 - lon1);
  const a = Math.sin(dlat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dlon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Busca restaurantes por radio y tipo de comida
export function findTopByPrestige({ lat, lon, radiusKm = 5, cuisine = "", limit = 9 }) {
  const want = (cuisine || "").toLowerCase().trim();
  const rows = DATA
    .filter(r => r.lat && r.lng)
    .map(r => {
      const dist = haversineKm(lat, lon, r.lat, r.lng);
      return { ...r, dist_km: dist };
    })
    .filter(r => r.dist_km <= radiusKm)
    .filter(r => (want ? (String(r.cuisine || "").toLowerCase().includes(want)) : true))
    .sort((a, b) => (b.prestige ?? 0) - (a.prestige ?? 0) || a.dist_km - b.dist_km)
    .slice(0, limit);

  return rows;
}
