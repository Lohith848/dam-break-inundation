# Dam Break Inundation Datasets — SIH26161

This directory contains real-world-calibrated geospatial and hydrological datasets for **Mettur Dam (Stanley Reservoir)** across the **Kaveri (Cauvery) River** (Salem & Erode districts, Tamil Nadu, India), as well as the **National Register of Large Dams in India** dataset.

## Directory Structure

```text
datasets/
│
├── dam/
│   ├── dam.geojson               # 6,644 National Register of Large Dams (NDSA) in India
│   └── mettur_parameters.csv      # Hydraulic & structural parameters of Mettur Dam
│
├── dem/
│   └── mettur_dem.tif            # Digital Elevation Model (SRTM/COP30 30m GeoTIFF)
│
├── river/
│   ├── mettur_river.geojson       # Kaveri river centerline & hydraulic reach specs
│   └── HydroRIVERS_TechDoc_v10.pdf # Technical specification for river network
│
├── villages/
│   └── villages.geojson          # Downstream settlements, populations & coordinates
│
├── satellite/
│   └── sentinel.tif              # Sentinel-2 RGB multi-band visual layer
│
└── population/
    └── worldpop.tif              # Gridded population distribution (WorldPop standard)
```

---

## Dataset Details

| Component | File | Format | Projection | Key Attributes & Details |
|---|---|---|---|---|
| **National Dams** | `dam/dam.geojson` | GeoJSON (Points) | WGS 84 (EPSG:4326) | 6,644 official Indian dams with PIC code, dam name, river, state, storage capacity, height, and coordinates. |
| **Mettur Dam Specs** | `dam/mettur_parameters.csv` | CSV | N/A | Full Reservoir Level (242.62m), Gross Capacity (2,640 MCM), Structural Height (65.23m), Crest Length (1,615m). |
| **Digital Elevation Model** | `dem/mettur_dem.tif` | GeoTIFF (Float32) | WGS 84 (EPSG:4326) | Bounds: `[77.68°E, 11.42°N]` to `[77.92°E, 11.88°N]`. Elevations ~148m to 520m MSL. Stanley reservoir pool & gorge. |
| **River Reach** | `river/mettur_river.geojson` | GeoJSON (LineString) | WGS 84 (EPSG:4326) | Kaveri River reach from Mettur Dam down to Bhavani confluence (~45 km reach). Contains Manning's $n$ and slope. |
| **Settlements** | `villages/villages.geojson` | GeoJSON (Points) | WGS 84 (EPSG:4326) | 10 downstream settlements: Mettur Town, Thangamapuripattanam, Navappatti, Konur, Nerinjipettai, Palamalai, Ammapettai, Singampettai, Bhavani, Komarapalayam. |
| **Satellite Imagery** | `satellite/sentinel.tif` | GeoTIFF (RGB UInt8) | WGS 84 (EPSG:4326) | Sentinel-2 visual layer aligned with DEM grid for land-cover context. |
| **Population Density** | `population/worldpop.tif` | GeoTIFF (Float32) | WGS 84 (EPSG:4326) | Gridded population count aligned with the flood plain to evaluate casualty and displacement risk. |

---

## Usage Example

```python
import csv
import json
import rasterio

# 1. Load Dam Parameters
dam_params = {}
with open("datasets/dam/mettur_parameters.csv", "r") as f:
    reader = csv.DictReader(f)
    for row in reader:
        dam_params[row["parameter"]] = row["value"]

# 2. Load National Dams List
with open("datasets/dam/dam.geojson", "r", encoding="utf-8") as f:
    dams_geojson = json.load(f)
    print(f"Loaded {len(dams_geojson['features'])} national dams")

# 3. Load DEM with rasterio
with rasterio.open("datasets/dem/mettur_dem.tif") as src:
    dem = src.read(1)
    print(f"DEM Shape: {dem.shape}, Bounds: {src.bounds}")
```
