// Major US airports (FAA large and medium hubs — where flights are frequent and
// cheap), for the "fly in, drive back" flag on a listing. Hardcoded: it changes
// rarely and costs nothing to look up. Coordinates are approximate (well within
// the flag's 50-mile threshold). Pure and import-free apart from geo.js.

import { haversineMi } from "./geo.js";

export const AIRPORTS = [
  ["ATL", 33.6407, -84.4277], ["DFW", 32.8998, -97.0403], ["DEN", 39.8561, -104.6737], ["ORD", 41.9742, -87.9073],
  ["LAX", 33.9416, -118.4085], ["JFK", 40.6413, -73.7781], ["LAS", 36.0840, -115.1537], ["MCO", 28.4312, -81.3081],
  ["MIA", 25.7959, -80.2870], ["CLT", 35.2144, -80.9473], ["SEA", 47.4502, -122.3088], ["PHX", 33.4352, -112.0101],
  ["EWR", 40.6895, -74.1745], ["SFO", 37.6213, -122.3790], ["IAH", 29.9902, -95.3368], ["BOS", 42.3656, -71.0096],
  ["FLL", 26.0742, -80.1506], ["MSP", 44.8848, -93.2223], ["LGA", 40.7769, -73.8740], ["DTW", 42.2162, -83.3554],
  ["PHL", 39.8744, -75.2424], ["SLC", 40.7899, -111.9791], ["BWI", 39.1754, -76.6684], ["DCA", 38.8512, -77.0402],
  ["SAN", 32.7338, -117.1933], ["IAD", 38.9531, -77.4565], ["TPA", 27.9755, -82.5332], ["BNA", 36.1263, -86.6774],
  ["AUS", 30.1975, -97.6664], ["MDW", 41.7868, -87.7522], ["HNL", 21.3245, -157.9251], ["DAL", 32.8471, -96.8518],
  ["PDX", 45.5898, -122.5951], ["STL", 38.7487, -90.3700], ["RDU", 35.8801, -78.7880], ["HOU", 29.6454, -95.2789],
  ["SMF", 38.6951, -121.5908], ["MSY", 29.9934, -90.2580], ["SJC", 37.3639, -121.9289], ["SAT", 29.5337, -98.4698],
  ["RSW", 26.5362, -81.7552], ["MCI", 39.2976, -94.7139], ["SNA", 33.6762, -117.8675], ["OAK", 37.7126, -122.2197],
  ["CLE", 41.4058, -81.8539], ["IND", 39.7173, -86.2944], ["PIT", 40.4915, -80.2329], ["CVG", 39.0489, -84.6678],
  ["CMH", 39.9980, -82.8919], ["JAX", 30.4941, -81.6879], ["ANC", 61.1743, -149.9963], ["ABQ", 35.0402, -106.6091],
  ["OKC", 35.3931, -97.6007], ["MEM", 35.0424, -89.9767], ["BUR", 34.2007, -118.3587], ["ONT", 34.0560, -117.6012],
  ["BDL", 41.9389, -72.6832], ["RIC", 37.5052, -77.3197], ["ORF", 36.8946, -76.2012], ["GSP", 34.8957, -82.2189],
  ["CHS", 32.8986, -80.0405], ["SAV", 32.1276, -81.2021], ["BHM", 33.5629, -86.7535], ["TUS", 32.1161, -110.9410],
  ["ELP", 31.8072, -106.3776], ["BOI", 43.5644, -116.2228], ["RNO", 39.4991, -119.7681], ["GEG", 47.6199, -117.5338],
  ["LIT", 34.7294, -92.2243], ["OMA", 41.3032, -95.8941], ["MKE", 42.9472, -87.8966], ["BUF", 42.9405, -78.7322],
  ["SDF", 38.1744, -85.7360], ["TUL", 36.1984, -95.8881], ["PBI", 26.6832, -80.0956],
];

// Nearest major airport to a point -> { code, mi } (whole miles), or null without coordinates.
export function nearestAirport(lat, lon) {
  const la = typeof lat === "string" ? parseFloat(lat) : lat;
  const lo = typeof lon === "string" ? parseFloat(lon) : lon;
  if (typeof la !== "number" || !isFinite(la) || typeof lo !== "number" || !isFinite(lo)) return null;
  let best = null;
  AIRPORTS.forEach(function (a) {
    const d = haversineMi(la, lo, a[1], a[2]);
    if (!best || d < best.mi) best = { code: a[0], mi: d };
  });
  return best ? { code: best.code, mi: Math.round(best.mi) } : null;
}
