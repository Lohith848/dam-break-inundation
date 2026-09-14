# Datasets & Geospatial Reference — SIH26161

The platform integrates real-world geospatial datasets covering dam structures, digital elevation models, river hydraulic geometries, downstream settlement census points, satellite imagery, and population density grids.

---

## Catalog Overview

| Dataset Category | Source / Organization | Coverage | Format | Spatial Resolution |
|---|---|---|---|---|
| **National Dams Database** | National Dam Safety Authority (NDSA) / CWC | 6,644 Dams across India | GeoJSON | Point Coordinates |
| **Mettur Dam Specs** | Water Resources Dept, Govt of Tamil Nadu | Mettur Dam (Stanley Reservoir) | CSV | Structural Attributes |
| **Digital Elevation Model** | SRTM / Copernicus DEM (COP30) | Kaveri Basin (11.42°N-11.88°N, 77.68°E-77.92°E) | GeoTIFF | 30 meter grid |
| **River Reach Geometry** | HydroSHEDS / HydroRIVERS | Kaveri River (~45 km reach) | GeoJSON | LineString Vector |
| **Settlement Census Points** | Census of India / OpenStreetMap | 10 Downstream Villages/Towns | GeoJSON | Point Coordinates |
| **Satellite Visual Layer** | Sentinel-2 MSI (ESA) | RGB Composite (Mettur Basin) | GeoTIFF | 10 meter grid |
| **Population Density Grid** | WorldPop Project | Gridded Population (2025) | GeoTIFF | 100 meter grid |

---

## 1. National Register of Large Dams (`datasets/dam/dam.geojson`)
Contains 6,644 validated dam records in India. Key properties:
- `dm_name`: Dam Name (e.g. *Mettur Dam*, *Idukki Dam*, *Tehri Dam*)
- `state` & `district`: Location administrative boundaries
- `river`: River or stream basin
- `ht_found`: Structural height above foundation ($m$)
- `gs_st_cap`: Gross storage capacity ($\text{MCM}$)
- `frl`: Full Reservoir Level ($\text{m MSL}$)
- `latitude` & `longitude`: Geodetic coordinates (WGS 84)

---

## 2. Digital Elevation Model (`datasets/dem/mettur_dem.tif` & Cache)
High-precision terrain grid providing surface elevation data ($z$ in meters MSL) used by the 2D diffusive-wave flood routing solver.
- Automatically falls back to fetching live tiles via OpenTopography API (`COP30` or `SRTM30`).
- Tiles cached in `datasets/dem/cache/` to eliminate redundant network fetches.

---

## 3. Downstream Settlements (`datasets/villages/villages.geojson`)
Tracked locations for arrival time computation and risk classification:
1. **Mettur Town** (Pop: 52,834)
2. **Thangamapuripattanam** (Pop: 18,420)
3. **Navappatti** (Pop: 8,110)
4. **Konur** (Pop: 9,250)
5. **Nerinjipettai** (Pop: 12,400)
6. **Palamalai** (Pop: 4,150)
7. **Ammapettai** (Pop: 14,800)
8. **Singampettai** (Pop: 7,920)
9. **Bhavani** (Pop: 39,225)
10. **Komarapalayam** (Pop: 48,500)
